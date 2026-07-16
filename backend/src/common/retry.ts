/**
 * Exponential backoff with full jitter, for outbound provider calls.
 *
 * The embedding path had no retry at all: a single 429 from the provider was
 * caught in `similaritySearch`, logged, and turned into an empty hit list — so
 * under load the agent silently stopped doing RAG and answered "no documents
 * found" from general knowledge. Retrying transient failures here, and letting
 * genuinely-exhausted ones throw, is what makes that failure visible instead.
 */

/** Statuses worth retrying: rate limits, and the 5xx family. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { statusCode?: number; status?: number }
  return e.statusCode ?? e.status
}

/**
 * A transient failure is one where the same request, sent again later, could
 * plausibly succeed: rate limits, upstream 5xx, and socket-level errors. A 400
 * (bad model id, malformed request) will fail identically forever — retrying it
 * just multiplies the latency before the user sees the error.
 */
export function isTransientError(err: unknown): boolean {
  const status = statusOf(err)
  if (status === 429) return true
  if (status !== undefined && status >= 500 && status <= 599) return true
  if (!err || typeof err !== 'object') return false

  const e = err as { code?: string; name?: string; message?: string }
  // Undici / Node socket errors surface as codes rather than statuses.
  const code = e.code ?? ''
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_HEADERS_TIMEOUT'
  ) {
    return true
  }
  if (e.name === 'AbortError') return false

  const msg = (e.message ?? '').toLowerCase()
  return (
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('overloaded') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up')
  )
}

/**
 * Honour a `Retry-After` header when the provider sent one — it's a better
 * estimate of when the quota window rolls than our backoff curve. Both the
 * seconds and the HTTP-date form are legal; we only handle seconds, which is
 * what OpenRouter/Google/OpenCode send.
 */
function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const headers = (err as { responseHeaders?: Record<string, string> }).responseHeaders
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (!raw) return undefined
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

export interface RetryOptions {
  /** Total attempts, including the first. `1` disables retrying. */
  attempts: number
  /** Delay before the first retry. Doubles each subsequent attempt. */
  baseDelayMs?: number
  /** Ceiling for a single backoff wait, before jitter. */
  maxDelayMs?: number
  /** Label used in the retry log line. */
  label: string
  /** Aborts the wait between attempts as well as the call itself. */
  signal?: AbortSignal
}

/**
 * Run `fn`, retrying transient failures with exponentially-growing, fully
 * jittered delays. Full jitter (a uniform draw from `[0, backoff]` rather than
 * `backoff ± noise`) is what stops 100 concurrent users who all got 429'd at
 * the same instant from retrying in lockstep and re-creating the burst that
 * rate-limited them.
 *
 * Non-transient errors, and the final attempt's error, are rethrown unchanged.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const { attempts, baseDelayMs = 500, maxDelayMs = 8_000, label, signal } = opts
  let lastErr: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw err
      if (attempt === attempts || !isTransientError(err)) throw err

      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
      const wait = retryAfterMs(err) ?? Math.random() * backoff
      console.warn(
        JSON.stringify({
          event: 'provider_retry',
          label,
          attempt,
          of: attempts,
          waitMs: Math.round(wait),
          status: statusOf(err) ?? null,
          reason: (err as Error)?.message?.slice(0, 200) ?? 'unknown',
        }),
      )
      await sleep(wait, signal)
    }
  }

  throw lastErr
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
