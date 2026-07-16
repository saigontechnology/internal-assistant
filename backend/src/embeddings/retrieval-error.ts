/**
 * Retrieval could not run — the embedding provider or the database failed.
 *
 * The distinction this class exists to draw: "the corpus has no answer" and
 * "we never got to look" are completely different facts, and the old code
 * collapsed them. `similaritySearch` caught every error, logged a warning, and
 * returned zero hits, so a rate-limited embedding call reached the agent as
 * "No matching documents found" — and the agent then told the user, with total
 * confidence, that their documents didn't cover the question.
 *
 * Under load that is the dominant failure mode, and it is invisible: no 500, no
 * error in the UI, just quietly wrong answers. Throwing instead lets the tool
 * layer hand the model an explicit RETRIEVAL_UNAVAILABLE sentinel, which the
 * system prompt teaches it to report honestly.
 */
export class RetrievalUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'RetrievalUnavailableError'
  }
}
