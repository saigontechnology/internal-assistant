-- Track the currently-active resumable stream id per chat. Non-null only
-- while a chat is mid-generation; cleared in the streamText onFinish path
-- and on explicit /api/chat/:id/stop. Used by the resume endpoint to look
-- up which stream to reconnect a client to.
ALTER TABLE "chat_histories"
  ADD COLUMN "active_stream_id" TEXT;
