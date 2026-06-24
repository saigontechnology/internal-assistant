import type { ProfileTuple } from './user-permission.service.js'

export type SyncJob = () => Promise<void>

interface QueuedEntry {
  profile: ProfileTuple
  job: SyncJob
}

/**
 * In-process serial queue for job-profile sync runs. One scan at a time across
 * all profiles — Graph QPS is the bottleneck, not CPU. Per-profile locking
 * (via `JobProfile.syncing`) is enforced separately in JobProfileSyncService;
 * this queue just serializes execution.
 *
 * No UI surface — users never see queue state. A server restart drops queued
 * entries; the next eligible request re-enqueues them via the resync gate.
 */
export class JobProfileSyncQueue {
  private active: ProfileTuple | null = null
  private waiting: QueuedEntry[] = []

  enqueue(profile: ProfileTuple, job: SyncJob): void {
    const same = (p: ProfileTuple) =>
      p.jobTitle === profile.jobTitle && p.department === profile.department
    if (this.active && same(this.active)) return
    if (this.waiting.some((e) => same(e.profile))) return
    this.waiting.push({ profile, job })
    if (!this.active) void this.drain()
  }

  isActive(profile: ProfileTuple): boolean {
    return Boolean(
      this.active &&
        this.active.jobTitle === profile.jobTitle &&
        this.active.department === profile.department,
    )
  }

  private async drain(): Promise<void> {
    while (this.waiting.length > 0) {
      const next = this.waiting.shift()!
      this.active = next.profile
      try {
        await next.job()
      } catch (err) {
        console.error(
          `[job-profile-sync ${next.profile.jobTitle}/${next.profile.department}] threw:`,
          err,
        )
      } finally {
        this.active = null
      }
    }
  }
}
