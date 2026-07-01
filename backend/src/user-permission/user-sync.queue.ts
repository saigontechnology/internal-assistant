/**
 * Single-slot in-process queue for per-user sync jobs.
 *
 * Only one job runs at a time (the global SP watcher is the same shape; this
 * mirrors it so contention is bounded). Additional users requesting a sync are
 * appended to a FIFO waiting list; their slot is exposed via `positionOf()`.
 *
 * Resets on process restart — the recovery path is `GET /api/user/permission`
 * re-enqueueing when `lastSync` is stale and no job is in-flight.
 */
export type SyncJob = () => Promise<void>

interface QueuedEntry {
  email: string
  job: SyncJob
  queuedAt: Date
}

interface ActiveEntry {
  email: string
  startedAt: Date
}

export class UserSyncQueue {
  private active: ActiveEntry | null = null
  private waiting: QueuedEntry[] = []

  /** Returns true if the user was enqueued, false if they were already in-flight or queued. */
  enqueue(email: string, job: SyncJob): 'started' | 'queued' | 'already_present' {
    if (this.active?.email === email) return 'already_present'
    if (this.waiting.some((e) => e.email === email)) return 'already_present'

    this.waiting.push({ email, job, queuedAt: new Date() })
    if (!this.active) {
      void this.drain()
      return 'started'
    }
    return 'queued'
  }

  isActive(email: string): boolean {
    return this.active?.email === email
  }

  /** 1-based position in the waiting list. null when running or idle. */
  positionOf(email: string): number | null {
    const idx = this.waiting.findIndex((e) => e.email === email)
    return idx === -1 ? null : idx + 1
  }

  queueLength(): number {
    return this.waiting.length
  }

  activeEmail(): string | null {
    return this.active?.email ?? null
  }

  activeStartedAt(): Date | null {
    return this.active?.startedAt ?? null
  }

  state(email: string): 'idle' | 'queued' | 'running' {
    if (this.isActive(email)) return 'running'
    if (this.positionOf(email) !== null) return 'queued'
    return 'idle'
  }

  private async drain(): Promise<void> {
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      this.active = { email: next.email, startedAt: new Date() }
      try {
        await next.job()
      } catch (err) {
        // Job is responsible for persisting its own error state on the row.
        // We log here so an uncaught throw doesn't disappear silently.
        console.error(`[user-sync ${next.email}] job threw:`, err)
      } finally {
        this.active = null
      }
    }
  }
}
