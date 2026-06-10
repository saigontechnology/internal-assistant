-- Phase A — SharePoint List watcher state + per-row sync status on resources.
-- See docs/sharepoint-list-watcher-plan.md §5.

CREATE TABLE "watcher_state" (
  "list_id"        TEXT PRIMARY KEY,
  "last_run_at"    TIMESTAMP(6),
  "last_status"    TEXT NOT NULL DEFAULT 'pending',
  "last_error"     TEXT,
  "items_seen"     INTEGER NOT NULL DEFAULT 0,
  "items_ingested" INTEGER NOT NULL DEFAULT 0,
  "items_updated"  INTEGER NOT NULL DEFAULT 0,
  "items_skipped"  INTEGER NOT NULL DEFAULT 0,
  "items_pending"  INTEGER NOT NULL DEFAULT 0,
  "items_removed"  INTEGER NOT NULL DEFAULT 0,
  "items_failed"   INTEGER NOT NULL DEFAULT 0
);

-- Tie each ingested resource to its source list row.
ALTER TABLE "resources" ADD COLUMN "sharepoint_list_id"  TEXT;
ALTER TABLE "resources" ADD COLUMN "sharepoint_code"     TEXT;
ALTER TABLE "resources" ADD COLUMN "sharepoint_version"  TEXT;
ALTER TABLE "resources" ADD COLUMN "source_metadata"     JSONB;
ALTER TABLE "resources" ADD COLUMN "sync_status"         TEXT NOT NULL DEFAULT 'synced';
ALTER TABLE "resources" ADD COLUMN "sync_error"          TEXT;
ALTER TABLE "resources" ADD COLUMN "last_sync_attempt"   TIMESTAMP(6);

-- (list_id, code) is the stable identity for SP-sourced rows.
-- Partial so the existing upload-mode rows (NULL code) don't collide.
CREATE UNIQUE INDEX "resources_sp_code_uk"
  ON "resources" ("sharepoint_list_id", "sharepoint_code")
  WHERE "sharepoint_code" IS NOT NULL;

-- Phase B uses this to find rows that need re-attempting under app-only auth.
CREATE INDEX "resources_sync_status_idx"
  ON "resources" ("sync_status")
  WHERE "sharepoint_code" IS NOT NULL;
