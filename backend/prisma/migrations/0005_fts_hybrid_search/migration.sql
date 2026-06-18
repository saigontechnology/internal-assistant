-- Hybrid retrieval: add a generated tsvector column on embeddings.content +
-- a GIN index so similaritySearch can fuse BM25-style FTS ranks with vector
-- ANN ranks via Reciprocal Rank Fusion (see EmbeddingsService.similaritySearch).
--
-- Hand-written because:
--   * Prisma has no first-class tsvector / GIN modeling here, and we don't
--     want the generated-column expression to be owned by Prisma (it would
--     be re-emitted on every schema drift). The column stays opaque to the
--     ORM, only used in raw SQL — same pattern as the halfvec column.
--   * `GENERATED ALWAYS AS (...) STORED` backfills automatically and stays
--     in sync on every UPDATE without a trigger.
--
-- The `english` text search config is the default; switch to a different
-- dictionary here if the corpus is predominantly another language.
--
-- Note: adding a STORED generated column rewrites the table. At docwise's
-- current scale (per-row sync from a SharePoint list) this is a one-time
-- few-second operation. If the embeddings table ever grows to hundreds of
-- millions of rows, replace with a non-generated column populated by a
-- trigger and backfill in batches.

ALTER TABLE "embeddings"
  ADD COLUMN IF NOT EXISTS "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', "content")) STORED;

CREATE INDEX IF NOT EXISTS "embeddings_content_tsv_idx"
  ON "embeddings"
  USING gin ("content_tsv");
