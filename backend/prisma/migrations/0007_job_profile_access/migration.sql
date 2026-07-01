-- Switch per-user permission model to job-profile-based access control.
-- See docs/role-based-access-plan.md (v4).

-- Repurpose user_permissions: drop the per-user setup columns, add the
-- normalized (job_title, department) tuple + display-form companions.
ALTER TABLE "user_permissions" DROP COLUMN IF EXISTS "first_syncing";
ALTER TABLE "user_permissions" DROP COLUMN IF EXISTS "list_unauthorized";
ALTER TABLE "user_permissions" DROP COLUMN IF EXISTS "syncing_started_at";
ALTER TABLE "user_permissions" DROP COLUMN IF EXISTS "items_seen";
ALTER TABLE "user_permissions" DROP COLUMN IF EXISTS "items_total";

ALTER TABLE "user_permissions"
  ADD COLUMN "job_title"          TEXT NOT NULL DEFAULT '__unassigned__';
ALTER TABLE "user_permissions"
  ADD COLUMN "department"         TEXT NOT NULL DEFAULT '__unassigned__';
ALTER TABLE "user_permissions"
  ADD COLUMN "display_job_title"  TEXT NOT NULL DEFAULT '';
ALTER TABLE "user_permissions"
  ADD COLUMN "display_department" TEXT NOT NULL DEFAULT '';

CREATE INDEX "user_permissions_profile_idx"
  ON "user_permissions" ("job_title", "department");

-- New job-profile cache. `last_sync` here is the authoritative resync cadence
-- (not the per-user lastSync on user_permissions). `syncing` is the in-flight
-- mutex so two users with the same profile don't both kick off a scan.
CREATE TABLE "job_profiles" (
  "job_title"        TEXT NOT NULL,
  "department"       TEXT NOT NULL,
  "last_sync"        TIMESTAMP(6),
  "synced_by_email"  TEXT,
  "syncing"          BOOLEAN NOT NULL DEFAULT false,
  "last_error"       TEXT,
  "created_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("job_title", "department")
);

-- Allow-list join table. Rebuilt at the end of every scan via
-- (DELETE WHERE profile) + (bulk INSERT) inside a single transaction.
CREATE TABLE "job_profile_access" (
  "job_title"       TEXT NOT NULL,
  "department"      TEXT NOT NULL,
  "sharepoint_code" TEXT NOT NULL,
  PRIMARY KEY ("job_title", "department", "sharepoint_code")
);

CREATE INDEX "job_profile_access_profile_idx"
  ON "job_profile_access" ("job_title", "department");

-- Drop the per-(email, code) cache from the previous design.
DROP TABLE IF EXISTS "user_resource_permissions";
