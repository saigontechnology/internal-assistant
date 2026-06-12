import type { UIMessage } from 'ai'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Per-chat-id persistence for UIMessage arrays. The frontend sends only the
 * latest message + chat id with each request; this service is how the
 * backend reconstitutes the conversation, and is also where the final
 * messages land via the streamText onFinish callback (which fires even if
 * the client disconnects, as long as we call result.consumeStream()).
 */
export class ChatHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns [] when no row exists yet (first message in a new chat). */
  async load(chatId: string): Promise<UIMessage[]> {
    const row = await this.prisma.chatHistory.findUnique({
      where: { id: chatId },
      select: { messages: true },
    })
    return (row?.messages as UIMessage[] | undefined) ?? []
  }

  /** Upsert: creates the row on first save, replaces messages on every subsequent finish. */
  async save(chatId: string, messages: UIMessage[]): Promise<void> {
    await this.prisma.chatHistory.upsert({
      where: { id: chatId },
      create: { id: chatId, messages: messages as object },
      update: { messages: messages as object },
    })
  }
}
