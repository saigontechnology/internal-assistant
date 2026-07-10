-- Admin-editable runtime settings.
--
-- Currently holds only the OpenCode chat-model ladder, so an admin can retune
-- the primary / fallback / second-fallback rungs from /admin/chat-model without
-- a redeploy. A missing row means "use the env default" — this table only ever
-- stores overrides, never a mirror of the env.

CREATE TABLE "app_settings" (
  "key"              TEXT PRIMARY KEY,
  "value"            TEXT NOT NULL,
  "updated_by_email" TEXT,
  "updated_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
