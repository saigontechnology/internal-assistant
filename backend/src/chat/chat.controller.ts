import { Controller, Inject, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { pipeUIMessageStreamToResponse, type UIMessage } from 'ai'
import { Public } from '../auth/public.decorator.js'
import { ChatService } from './chat.service.js'

@Controller()
export class ChatController {
  constructor(@Inject(ChatService) private readonly chatService: ChatService) {}

  /**
   * Public to match the legacy Hono route (no requireAuth on /api/chat).
   * Streams via @Res() — calling pipeUIMessageStreamToResponse takes over
   * the express response, so the handler must NOT return a value (Nest
   * would try to serialize it on top of the stream).
   */
  @Public()
  @Post('chat')
  async stream(@Req() req: Request, @Res() res: Response) {
    const { messages } = req.body as { messages: UIMessage[] }
    const result = await this.chatService.streamChat(messages)
    pipeUIMessageStreamToResponse({ response: res, stream: result.toUIMessageStream() })
  }
}
