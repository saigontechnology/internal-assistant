-- Indexes for the hot read paths at 100 concurrent users.
--
-- Hand-written (not `prisma migrate dev`) for the same reason as 0001 and 0005:
-- these sit alongside the pgvector/FTS indexes on tables Prisma only partly
-- owns, and CONCURRENTLY can't run inside the transaction prisma migrate wraps
-- a generated migration in. Keep them here.
--
-- All are IF NOT EXISTS so re-applying is a no-op.

-- similaritySearch's `filenames` argument compiles to `r.filename IN (...)`.
-- Without an index this is a sequential scan of `resources` on a query that
-- already costs a vector scan.
CREATE INDEX IF NOT EXISTS "resources_filename_idx"
  ON "resources" ("filename");

-- The access-control predicate reads `r.sharepoint_code` for every candidate
-- (both the `IS NULL` public check and the job_profile_access join key), and
-- `demoteOrphanedSharepointRows` filters on it during every sync.
CREATE INDEX IF NOT EXISTS "resources_sharepoint_code_idx"
  ON "resources" ("sharepoint_code");

-- Chat ownership is checked on every single chat request (assertOwner), and the
-- owner column arrived in 0015 without one.
CREATE INDEX IF NOT EXISTS "chat_histories_owner_email_idx"
  ON "chat_histories" ("owner_email");

-- `getActiveStreamId` and the resume path look up chats that are mid-stream.
-- Partial, because the column is NULL for every chat that isn't generating
-- right now — which is nearly all of them. The index therefore holds only the
-- handful of live streams rather than a row per chat ever created.
CREATE INDEX IF NOT EXISTS "chat_histories_active_stream_idx"
  ON "chat_histories" ("active_stream_id")
  WHERE "active_stream_id" IS NOT NULL;
