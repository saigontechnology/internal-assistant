import type { UIMessage } from 'ai'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Per-chat-id persistence for UIMessage arrays and the currently-active
 * resumable-stream id.
 *
 * The frontend sends only the latest message + chat id with each request;
 * this service is how the backend reconstitutes the conversation. It's also
 * where final messages land after the streamText run finishes (the
 * `onFinish`/`onEnd` callback fires even when the client has disconnected,
 * because resumable-stream keeps draining server-side).
 *
 * `activeStreamId` is the pointer to the Redis-backed stream that a
 * resuming client can reconnect to via GET /api/chat/:id/stream. It's set
 * as soon as we create the resumable stream and cleared when generation
 * finishes (or is explicitly stopped).
 */
export class ChatHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ownership of a chat, for the cross-user access check in ChatController.
   * `exists=false` → no row yet (a brand-new chat id, free to claim).
   * `ownerEmail=null` → a legacy row from before ownership existed.
   */
  async getOwnership(chatId: string): Promise<{ exists: boolean; ownerEmail: string | null }> {
    const row = await this.prisma.chatHistory.findUnique({
      where: { id: chatId },
      select: { ownerEmail: true },
    })
    return { exists: row !== null, ownerEmail: row?.ownerEmail ?? null }
  }

  /**
   * Stamp the owner on a chat: create the row owned by `ownerEmail`, or adopt
   * an existing owner-less (legacy) row for this caller. Never overwrites an
   * owner that is already set — callers must have passed the getOwnership()
   * check first. Called at the start of POST /api/chat.
   */
  async claimOwnership(chatId: string, ownerEmail: string): Promise<void> {
    await this.prisma.chatHistory.upsert({
      where: { id: chatId },
      create: { id: chatId, ownerEmail },
      update: {},
    })
    // Separate step so a legacy row (owner_email IS NULL) is adopted, while a
    // row already owned by someone is left untouched.
    await this.prisma.chatHistory.updateMany({
      where: { id: chatId, ownerEmail: null },
      data: { ownerEmail },
    })
  }

  /** Returns [] when no row exists yet (first message in a new chat). */
  async load(chatId: string): Promise<UIMessage[]> {
    const row = await this.prisma.chatHistory.findUnique({
      where: { id: chatId },
      select: { messages: true },
    })
    return (row?.messages as UIMessage[] | undefined) ?? []
  }

  /** Read the currently-active resumable stream id, or null if none. */
  async getActiveStreamId(chatId: string): Promise<string | null> {
    const row = await this.prisma.chatHistory.findUnique({
      where: { id: chatId },
      select: { activeStreamId: true },
    })
    return row?.activeStreamId ?? null
  }

  /**
   * Set (or clear) the active stream pointer. Upserts so first-message
   * chats also get a row created; the messages column stays at its
   * default `[]` until save() runs.
   */
  async setActiveStreamId(chatId: string, streamId: string | null): Promise<void> {
    await this.prisma.chatHistory.upsert({
      where: { id: chatId },
      create: { id: chatId, activeStreamId: streamId },
      update: { activeStreamId: streamId },
    })
  }

  /** Upsert: creates the row on first save, replaces messages on every subsequent finish. */
  async save(chatId: string, messages: UIMessage[]): Promise<void> {
    await this.prisma.chatHistory.upsert({
      where: { id: chatId },
      create: { id: chatId, messages: messages as object },
      update: { messages: messages as object },
    })
  }

  /**
   * Save the finished message list AND clear activeStreamId — but only if
   * it still points at `expectedStreamId`. Guards against the case where
   * a newer stream has already claimed the chat while this one was
   * finishing (e.g. user hit send again before onEnd landed): we still
   * write the messages, but we don't clobber the newer stream pointer.
   */
  async saveAndClearActive(
    chatId: string,
    messages: UIMessage[],
    expectedStreamId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.chatHistory.findUnique({
        where: { id: chatId },
        select: { activeStreamId: true },
      })
      const shouldClear = row?.activeStreamId === expectedStreamId
      await tx.chatHistory.upsert({
        where: { id: chatId },
        create: {
          id: chatId,
          messages: messages as object,
          activeStreamId: null,
        },
        update: {
          messages: messages as object,
          ...(shouldClear ? { activeStreamId: null } : {}),
        },
      })
    })
  }
}
