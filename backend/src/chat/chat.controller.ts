import {
  BadRequestException,
  Controller,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { readUIMessageStream, type UIMessage } from 'ai'
import type { Session } from '@prisma/client'
import { EffectiveProfileService } from '../user-permission/effective-profile.service.js'
import { ChatHistoryService } from './chat-history.service.js'
import { ChatService } from './chat.service.js'

interface ChatRequestBody {
  /** Client-supplied chat id (frontend nanoid). Created on the backend on first send. */
  id: string
  /** The single new user message — full history is loaded server-side by `id`. */
  message: UIMessage
}

@Controller()
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chatService: ChatService,
    @Inject(ChatHistoryService) private readonly history: ChatHistoryService,
    @Inject(EffectiveProfileService) private readonly effective: EffectiveProfileService,
  ) {}

  /**
   * POST /api/chat
   *
   * - "Send only the last message": frontend posts `{ id, message }`. We load
   *   prior turns from `chat_histories` by id and append the new one before
   *   calling streamText.
   *
   * - "Survive client disconnect with the full assistant turn intact": we run
   *   TWO independent readers on the streamText result.
   *
   *     1. A background UIMessage reader that iterates to completion and
   *        upserts the final assistant message into chat_histories.
   *     2. The HTTP response pipe to the actual client.
   *
   *   The two are teed by the SDK; aborting the HTTP pipe (because the
   *   client closed the tab, clicked Pause, or lost the network) does not
   *   abort the background reader. The LLM stream therefore drains fully
   *   server-side, and the persisted messages always reflect what the model
   *   actually produced — not what the client managed to receive.
   *
   *   This is the simpler half of the AI SDK's "resumable streams" pattern:
   *   it makes the saved state correct after a disconnect. Full live-resume
   *   on the client (so the user's UI catches the rest of an in-flight
   *   response after refresh) additionally needs Redis + the resumable-stream
   *   package; left as a follow-up.
   */
  @Post('chat')
  async stream(@Req() req: Request, @Res() res: Response) {
    const { id, message } = (req.body ?? {}) as Partial<ChatRequestBody>
    if (!id) throw new BadRequestException('Missing chat `id`')
    if (!message) throw new BadRequestException('Missing `message`')

    // SessionGuard has already attached the session for non-public routes.
    const session = (req as Request & { session: Session }).session

    // Resolve the effective (jobTitle, department) tuple — applies the fallback
    // chain (user → default fallback → public-only) and triggers side effects
    // (cold-start scan / weekly re-evaluation). See docs/role-based-access-plan.md §8.
    const eff = await this.effective.resolve(session)

    const previous = await this.history.load(id)
    const messages: UIMessage[] = [...previous, message]

    const { result, originalMessages } = await this.chatService.streamReply(messages, {
      viewer: eff.publicOnly ? undefined : eff.viewer,
      publicOnly: eff.publicOnly,
    })

    // ── Reader #1: background persistence ──
    void (async () => {
      console.log(`[persist ${id}] starting`)
      let lastAssistantMessage: UIMessage | undefined
      let chunks = 0
      try {
        const persistStream = result.toUIMessageStream({ originalMessages })
        for await (const m of readUIMessageStream({ stream: persistStream })) {
          lastAssistantMessage = m
          chunks++
        }
        console.log(`[persist ${id}] stream finished, ${chunks} message snapshots`)
      } catch (err) {
        console.error(`[persist ${id}] consumer errored after ${chunks} snapshots:`, err)
      }
      const finalMessages: UIMessage[] = lastAssistantMessage
        ? [...originalMessages, lastAssistantMessage]
        : originalMessages
      try {
        await this.history.save(id, finalMessages)
        console.log(`[persist ${id}] saved ${finalMessages.length} messages`)
      } catch (err) {
        console.error(`[persist ${id}] failed to save:`, err)
      }
    })()

    // ── Reader #2: HTTP response pipe ──
    result.pipeUIMessageStreamToResponse(res, { originalMessages })
  }
}
