-- Backend-side chat history so the frontend can send only the latest
-- message + chat id, and so disconnect-during-stream still persists the
-- final messages via consumeStream() + onFinish.
CREATE TABLE "chat_histories" (
  "id"         TEXT PRIMARY KEY,
  "messages"   JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
