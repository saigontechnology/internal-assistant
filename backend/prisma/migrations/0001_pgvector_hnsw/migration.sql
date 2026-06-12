-- Add the HNSW ANN index on the embedding column. This lives in a hand-written
-- migration because:
--   * prisma migrate has no syntax for `USING hnsw (col halfvec_cosine_ops)`.
--   * The column itself is `Unsupported("halfvec(2048)")` in schema.prisma,
--     so prisma migrate can't introspect or own any index on it.
--
-- Idempotent so re-applying is safe (also lets `prisma migrate resolve
-- --applied 0001_pgvector_hnsw` on the existing dev DB succeed without churn).
CREATE INDEX IF NOT EXISTS "embeddings_hnsw_idx"
  ON "embeddings"
  USING hnsw (embedding halfvec_cosine_ops);
