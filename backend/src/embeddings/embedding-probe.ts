/**
 * The dimension the `embeddings.embedding` column is declared with
 * (`halfvec(2048)` in schema.prisma) and the HNSW index is built against.
 *
 * This is the number that makes the embedding model editable at all. A model
 * with a different output dimension doesn't error on write — it writes vectors
 * from a different embedding space into the same column, and retrieval quietly
 * returns nonsense until someone re-embeds the corpus. So the admin write path
 * probes the candidate model and refuses anything that doesn't land on exactly
 * this many dimensions. See EmbeddingsService.probeDimension.
 */
export const EMBEDDING_DIMENSION = 2048

/**
 * The slice of EmbeddingsService the settings registry is allowed to see.
 *
 * Kept as a standalone interface so `setting-defs.ts` — a pure registry that
 * everything imports — doesn't have to pull in the embeddings service and its
 * whole dependency tree just to validate one field.
 */
export interface EmbeddingProbe {
  /** Embed a short probe string with `model` and report the vector's length. */
  probeDimension(model: string): Promise<number>
}
