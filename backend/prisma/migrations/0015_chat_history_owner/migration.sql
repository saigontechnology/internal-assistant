-- Add per-chat ownership so /api/chat/:id/* can reject cross-user access.
-- Nullable: existing rows predate ownership and are adopted by their first
-- authenticated accessor at runtime; new chats are stamped on first write.
ALTER TABLE "chat_histories" ADD COLUMN "owner_email" TEXT;
