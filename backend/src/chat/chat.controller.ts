import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { UI_MESSAGE_STREAM_HEADERS, type UIMessage } from 'ai'
import { nanoid } from 'nanoid'
import type { Session } from '@prisma/client'
import { EffectiveProfileService } from '../user-permission/effective-profile.service.js'
import { ActiveStreamRegistry } from './active-stream-registry.js'
import { ChatHistoryService } from './chat-history.service.js'
import { ChatService } from './chat.service.js'
import { ResumableStreamService } from './resumable-stream.service.js'

interface ChatRequestBody {
  /** Client-supplied chat id (frontend nanoid). Created on the backend on first send. */
  id: string
  /** The single new user message — full history is loaded server-side by `id`. */
  message: UIMessage
}

interface StopRequestBody {
  /**
   * Optional guard: the streamId the client believes is active. If it
   * doesn't match the server's current activeStreamId, the stop is a
   * no-op (a newer stream has already superseded the one the client
   * wanted to cancel).
   */
  activeStreamId?: string | null
  /** Partial assistant message the client managed to render. Persisted as-is. */
  assistantMessage?: UIMessage
}

@Controller()
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chatService: ChatService,
    @Inject(ChatHistoryService) private readonly history: ChatHistoryService,
    @Inject(EffectiveProfileService) private readonly effective: EffectiveProfileService,
    @Inject(ResumableStreamService) private readonly resumable: ResumableStreamService,
    @Inject(ActiveStreamRegistry) private readonly registry: ActiveStreamRegistry,
  ) {}

  /**
   * POST /api/chat
   *
   * - "Send only the last message": frontend posts `{ id, message }`. We load
   *   prior turns from `chat_histories` by id and append the new one before
   *   calling streamText.
   *
   * - "Survive client disconnect with the full assistant turn intact AND
   *   let the client reconnect mid-stream": the outgoing SSE stream is
   *   tee'd via `consumeSseStream`. One copy pipes to the current HTTP
   *   response; the other is registered as a resumable stream in Redis
   *   (via `resumable-stream`). If the client disconnects, the resumable
   *   copy keeps draining server-side, the final assistant message lands
   *   in `chat_histories`, and a reconnecting client can pick up mid-stream
   *   via GET /api/chat/:id/stream.
   *
   * - "Concurrent-send guard": if this chat already has an active stream,
   *   we reject with 409. The frontend won't POST twice under normal
   *   operation (the send button is disabled while `status === 'streaming'`);
   *   this exists to catch pathological cases like a stale tab replaying a
   *   send after refresh.
   */
  @Post('chat')
  async stream(@Req() req: Request, @Res() res: Response) {
    const { id, message } = (req.body ?? {}) as Partial<ChatRequestBody>
    if (!id) throw new BadRequestException('Missing chat `id`')
    if (!message) throw new BadRequestException('Missing `message`')

    // Guard concurrent sends to the same chat: an existing activeStreamId
    // means the previous generation is still in flight (or the server crashed
    // mid-stream and never cleared it — the client is expected to call
    // /api/chat/:id/stop to unblock in that case).
    const existingActive = await this.history.getActiveStreamId(id)
    if (existingActive) {
      throw new ConflictException(
        'A previous response is still being generated for this chat.',
      )
    }

    // SessionGuard has already attached the session for non-public routes.
    const session = (req as Request & { session: Session }).session

    // Resolve the effective (jobTitle, department) tuple — applies the fallback
    // chain (user → default fallback → public-only) and triggers side effects
    // (cold-start scan / weekly re-evaluation). See docs/role-based-access-plan.md §8.
    const eff = await this.effective.resolve(session)

    const previous = await this.history.load(id)
    const messages: UIMessage[] = [...previous, message]

    const streamId = nanoid()
    const abortController = this.registry.register(streamId)

    const { result, originalMessages } = await this.chatService.streamReply(messages, {
      viewer: eff.publicOnly ? undefined : eff.viewer,
      publicOnly: eff.publicOnly,
      abortSignal: abortController.signal,
    })

    const ctx = await this.resumable.getContext()

    // Pipe the SSE stream to the response AND (via the tee'd copy in
    // consumeSseStream) register it as a resumable stream in Redis. Both
    // drain independently — if the client aborts the HTTP pipe, the
    // resumable copy keeps going until the LLM run finishes.
    result.pipeUIMessageStreamToResponse(res, {
      originalMessages,
      onFinish: async ({ messages: finalMessages }) => {
        this.registry.release(streamId)
        try {
          await this.history.saveAndClearActive(id, finalMessages, streamId)
        } catch (err) {
          console.error(`[chat ${id}] failed to save messages:`, err)
        }
      },
      consumeSseStream: async ({ stream }) => {
        try {
          await ctx.createNewResumableStream(streamId, () => stream)
          await this.history.setActiveStreamId(id, streamId)
        } catch (err) {
          // Best-effort: resume simply won't work for this stream. The
          // response pipe is independent, so the current client still gets
          // the answer live.
          console.error(`[chat ${id}] failed to register resumable stream:`, err)
          this.registry.release(streamId)
        }
      },
    })
  }

  /**
   * GET /api/chat/:id/stream
   *
   * Reconnect to an in-flight stream. Returns 204 when no stream is active
   * (the client's `useChat({ resume: true })` treats that as "nothing to
   * resume" and stays in idle). Otherwise pipes the live Redis-backed
   * copy of the SSE stream. The producer keeps draining even if this
   * response ends — a second reconnect picks up from wherever it left off.
   */
  @Get('chat/:id/stream')
  async resume(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const activeStreamId = await this.history.getActiveStreamId(id)
    if (!activeStreamId) {
      res.status(204).end()
      return
    }

    const ctx = await this.resumable.getContext()
    const stream = await ctx.resumeExistingStream(activeStreamId)

    if (!stream) {
      // Either the stream never existed (shouldn't happen — DB says it did)
      // or it's already fully finished. Treat as "nothing to resume" so the
      // client falls back to the persisted messages.
      res.status(204).end()
      return
    }

    for (const [key, value] of Object.entries(UI_MESSAGE_STREAM_HEADERS)) {
      res.setHeader(key, value)
    }
    res.status(200)

    // Bridge the Web ReadableStream<string> to Express `res`.
    const reader = stream.getReader()
    const close = () => {
      reader.cancel().catch(() => {})
    }
    res.once('close', close)
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!res.write(value)) {
          await new Promise<void>((resolve) => res.once('drain', resolve))
        }
      }
    } catch (err) {
      console.error(`[chat ${id}] resume stream errored:`, err)
    } finally {
      res.off('close', close)
      res.end()
    }
  }

  /**
   * POST /api/chat/:id/stop
   *
   * Explicit user cancel. `useChat.stop()` alone would only close the
   * client's HTTP connection — with resumable streams that would leave
   * the LLM run happily burning tokens server-side. So the client calls
   * this endpoint too:
   *   1. persist the partial assistant message it managed to render,
   *   2. abort the LLM call via the AbortController held in the registry,
   *   3. clear activeStreamId iff it still matches the streamId the client
   *      wanted to cancel (never clobber a newer stream).
   *
   * Multi-instance caveat: the AbortController lives on the instance that
   * started the stream. If we ever scale horizontally, this needs a Redis
   * pub/sub broadcast so any instance can cancel any stream. Not needed
   * for v1.
   */
  @Post('chat/:id/stop')
  async stop(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ success: true }> {
    const currentActive = await this.history.getActiveStreamId(id)
    if (!currentActive) {
      // Nothing to cancel — either never started or already finished.
      return { success: true }
    }

    const body = (req.body ?? {}) as StopRequestBody

    // Client sent a stale streamId — a newer stream has already started
    // for this chat, don't touch it.
    if (body.activeStreamId != null && body.activeStreamId !== currentActive) {
      return { success: true }
    }

    if (body.assistantMessage) {
      try {
        const messages = await this.history.load(id)
        const merged = mergeAssistantSnapshot(messages, body.assistantMessage)
        await this.history.save(id, merged)
      } catch (err) {
        console.error(`[chat ${id}] failed to persist stop snapshot:`, err)
      }
    }

    // Abort the LLM run on this instance. release() is a no-op if the
    // stream has already been released by onFinish.
    this.registry.abort(currentActive)

    // Compare-and-swap clear — only clear if it still points at the stream
    // we just aborted.
    const latest = await this.history.getActiveStreamId(id)
    if (latest === currentActive) {
      await this.history.setActiveStreamId(id, null)
    }

    return { success: true }
  }
}

/**
 * Insert-or-merge the partial assistant message into the message list.
 * Never overwrite a message that is already present with a different role,
 * and if an assistant message with the same id exists, replace it (the
 * incoming snapshot is at least as recent as the stored one).
 */
function mergeAssistantSnapshot(
  messages: UIMessage[],
  snapshot: UIMessage,
): UIMessage[] {
  if (snapshot.role !== 'assistant') return messages
  const idx = messages.findIndex((m) => m.id === snapshot.id)
  if (idx === -1) return [...messages, snapshot]
  if (messages[idx]?.role !== 'assistant') return messages
  const next = messages.slice()
  next[idx] = snapshot
  return next
}
