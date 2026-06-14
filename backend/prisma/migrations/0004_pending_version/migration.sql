-- Track newer Ver detected on the source list when no caller could resolve
-- the new file. Existing embeddings remain valid for `sharepoint_version`.
ALTER TABLE "resources" ADD COLUMN "sharepoint_pending_version" TEXT;

-- Allowlist of usernames (emails / UPNs from the MSAL session) permitted to
-- trigger a sync. Anyone else gets a read-only view and a Refresh button.
-- Lowercased on write/read so the check is case-insensitive.
CREATE TABLE "sync_allowlist" (
  "email"      TEXT PRIMARY KEY,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT now()
);

INSERT INTO "sync_allowlist" ("email") VALUES ('copilot.hr@saigontechnology.com');
