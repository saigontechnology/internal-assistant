/**
 * Counting semaphore for outbound provider calls.
 *
 * Without one, 100 concurrent users fire 100 simultaneous embedding requests at
 * the provider, which rate-limits the lot of them; the retries then fire in
 * another burst. Capping in-flight calls turns that thundering herd into a
 * queue: the provider sees a steady stream at a rate it will actually serve,
 * and callers wait rather than fail.
 *
 * The limit is read through a getter on every acquire rather than captured at
 * construction, so an admin changing it at /admin/settings takes effect on the
 * next call instead of at the next restart. Lowering it below the current
 * in-flight count doesn't cancel anything — it just stops new work from
 * starting until the count drains under the new limit.
 */
export class Semaphore {
  private inFlight = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly limit: () => number) {}

  /** Current in-flight count. Exposed for the /health capacity readout. */
  get active(): number {
    return this.inFlight
  }

  /** Callers currently parked waiting for a slot. */
  get waiting(): number {
    return this.queue.length
  }

  /**
   * Run `fn` once a slot is free. The slot is always released, including when
   * `fn` throws — otherwise one failed call would permanently shrink capacity.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /**
   * Take a slot, waiting if none is free. Public because a streaming
   * generation can't use `run()`: `streamText` returns as soon as the stream
   * *starts*, so the slot has to be held past the end of the call and released
   * from the stream's own completion callbacks. Every `acquire()` must be
   * paired with exactly one `release()` on every exit path — see ChatService.
   */
  async acquire(): Promise<void> {
    const max = Math.max(1, this.limit())
    if (this.inFlight < max) {
      this.inFlight++
      return
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.inFlight++
  }

  release(): void {
    this.inFlight--
    const max = Math.max(1, this.limit())
    // Re-check the limit on release: it may have been lowered while this call
    // was in flight, in which case we drain rather than hand the slot on.
    if (this.inFlight < max) {
      this.queue.shift()?.()
    }
  }
}
