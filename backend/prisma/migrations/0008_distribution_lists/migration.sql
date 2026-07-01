-- Registry-driven multi-list watcher. See docs/multi-list-watcher-plan.md.
--
-- Three tables:
--   distribution_lists           — one row per registry row (intent)
--   distribution_list_items      — per-doc intent (vs. resources' outcome)
--   job_profile_distribution_lists — which profiles see which lists

CREATE TABLE "distribution_lists" (
  "id"                TEXT PRIMARY KEY,
  "registry_list_id"  TEXT NOT NULL,
  "registry_item_id"  TEXT NOT NULL,
  "display_name"      TEXT NOT NULL,
  "note"              TEXT,
  "list_url"          TEXT NOT NULL,
  "site_id"           TEXT,
  "target_list_id"    TEXT,
  "last_seen_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_synced_at"    TIMESTAMP(6),
  "last_sync_status"  TEXT NOT NULL DEFAULT 'pending',
  "last_sync_error"   TEXT,
  "items_synced"      INTEGER NOT NULL DEFAULT 0,
  "items_pending"     INTEGER NOT NULL DEFAULT 0,
  "items_failed"      INTEGER NOT NULL DEFAULT 0,
  "items_removed"     INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "distribution_lists_registry_uk"
  ON "distribution_lists" ("registry_list_id", "registry_item_id");

CREATE INDEX "distribution_lists_target_idx"
  ON "distribution_lists" ("target_list_id");


CREATE TABLE "distribution_list_items" (
  "id"                   TEXT PRIMARY KEY,
  "distribution_list_id" TEXT NOT NULL,
  "resource_id"          TEXT,
  "sharepoint_code"      TEXT NOT NULL,
  "sharepoint_title"     TEXT NOT NULL DEFAULT '',
  "sharepoint_version"   TEXT NOT NULL DEFAULT '',
  "last_seen_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sync_status"          TEXT NOT NULL DEFAULT 'pending',
  "sync_error"           TEXT,
  "created_at"           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "dli_distribution_list_fk"
    FOREIGN KEY ("distribution_list_id") REFERENCES "distribution_lists"("id") ON DELETE CASCADE,
  CONSTRAINT "dli_resource_fk"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "dli_distribution_code_uk"
  ON "distribution_list_items" ("distribution_list_id", "sharepoint_code");

CREATE INDEX "dli_resource_idx"
  ON "distribution_list_items" ("resource_id");

CREATE INDEX "dli_status_idx"
  ON "distribution_list_items" ("sync_status");


CREATE TABLE "job_profile_distribution_lists" (
  "job_title"            TEXT NOT NULL,
  "department"           TEXT NOT NULL,
  "distribution_list_id" TEXT NOT NULL,
  "first_seen_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY ("job_title", "department", "distribution_list_id"),
  CONSTRAINT "jpdl_profile_fk"
    FOREIGN KEY ("job_title", "department") REFERENCES "job_profiles"("job_title", "department") ON DELETE CASCADE,
  CONSTRAINT "jpdl_distribution_list_fk"
    FOREIGN KEY ("distribution_list_id") REFERENCES "distribution_lists"("id") ON DELETE CASCADE
);

CREATE INDEX "jpdl_distribution_idx"
  ON "job_profile_distribution_lists" ("distribution_list_id");
