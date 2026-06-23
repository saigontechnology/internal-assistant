-- Per-user permission tracking. See docs/per-user-sync-plan.md.

CREATE TABLE "user_permissions" (
  "email"               TEXT PRIMARY KEY,
  "first_syncing"       BOOLEAN NOT NULL DEFAULT true,
  "list_unauthorized"   TEXT    NOT NULL DEFAULT '',
  "last_sync"           TIMESTAMP(6),
  "syncing_started_at"  TIMESTAMP(6),
  "items_seen"          INTEGER,
  "items_total"         INTEGER,
  "last_error"          TEXT,
  "created_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "user_permissions_first_syncing_idx"
  ON "user_permissions" ("first_syncing");

-- Per-user (code → authorized?) cache. Refreshed on weekly resync when older
-- than the configured TTL (USER_PERM_CACHE_TTL_DAYS, default 30 days).
CREATE TABLE "user_resource_permissions" (
  "email"           TEXT NOT NULL,
  "sharepoint_code" TEXT NOT NULL,
  "authorized"      BOOLEAN NOT NULL,
  "checked_at"      TIMESTAMP(6) NOT NULL,
  PRIMARY KEY ("email", "sharepoint_code")
);

CREATE INDEX "user_resource_permissions_email_idx"
  ON "user_resource_permissions" ("email");
