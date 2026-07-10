-- Admin portal: user roles + DB-owned distribution lists.
--
-- Purely additive. Existing rows keep working: users default to role='user'
-- and is_active=true; distribution_lists rows keep their registry ids and
-- default to enabled=true.

-- ── user_permissions: role, activation, profile override ────────────────

-- 'admin' | 'user'. Not a PG enum so future values need no type migration.
ALTER TABLE "user_permissions" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'user';

-- Deactivated users are rejected at login and on every subsequent request.
ALTER TABLE "user_permissions" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;

-- When true, the Azure AD sync must not overwrite (job_title, department).
ALTER TABLE "user_permissions" ADD COLUMN "profile_override" BOOLEAN NOT NULL DEFAULT false;

-- ── distribution_lists: the DB is now the source of truth ───────────────

-- Registry columns become provenance-only: NULL for admin-created rows.
-- The `distribution_lists_registry_uk` unique index survives untouched —
-- Postgres treats NULLs as distinct, so admin rows never collide.
ALTER TABLE "distribution_lists" ALTER COLUMN "registry_list_id" DROP NOT NULL;
ALTER TABLE "distribution_lists" ALTER COLUMN "registry_item_id" DROP NOT NULL;

-- Disabled lists are skipped by the watcher and the job-profile scan.
ALTER TABLE "distribution_lists" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "distribution_lists" ADD COLUMN "created_by_email" TEXT;

-- Rows the old registry sweep marked as gone would otherwise be resurrected
-- by the DB-driven watcher. Retire them explicitly instead.
UPDATE "distribution_lists" SET "enabled" = false WHERE "last_sync_status" = 'removed';
