import type { Session } from '@prisma/client'
import { SessionService } from '../auth/session.service.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsService } from '../documents/documents.service.js'
import { DelegatedGraphTokenProvider } from '../sharepoint-list/graph-token-provider.js'
import { SharepointListService } from '../sharepoint-list/sharepoint-list.service.js'
import { JobProfileSyncQueue } from './job-profile-sync.queue.js'
import { JobProfileService } from './job-profile.service.js'
import {
  UserPermissionService,
  type ProfileTuple,
} from './user-permission.service.js'

/**
 * Runs one scan for a (jobTitle, department) profile using the triggering
 * user's delegated Graph token.
 *
 * Two responsibilities, same loop:
 *   1. Backfill the shared `resources` index with documents the user can see
 *      that aren't yet in our DB (same as the global SP watcher, but per-user).
 *   2. Replace this profile's allow-list in `job_profile_access` with the
 *      sharepointCodes the user could successfully resolve.
 *
 * Resolve failure = "this profile can't see this doc." Known false-positive
 * class (filename divergence) accepted — see docs/role-based-access-plan.md §10.
 */
const ACCESS_FLUSH_BATCH_SIZE = 10

export class JobProfileSyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly listSvc: SharepointListService,
    private readonly documents: DocumentsService,
    private readonly perms: UserPermissionService,
    private readonly profiles: JobProfileService,
    private readonly queue: JobProfileSyncQueue,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Decide whether to scan for this user on this request and enqueue if so.
   * Caller passes the user's normalized profile tuple (resolved from
   * user_permissions). Logic mirrors docs §4 Scenario C:
   *
   *   - User lastSync fresh           → noop
   *   - User stale, profile stale     → enqueue scan
   *   - User stale, profile fresh     → bump user lastSync, skip scan
   *   - User stale, profile syncing   → bump user lastSync, skip scan
   */
  async evaluateAndMaybeEnqueue(session: Session, profile: ProfileTuple): Promise<void> {
    const email = session.username
    if (!email) return
    const user = await this.perms.findByEmail(email)
    if (!user) return
    if (!isStale(user.lastSync, this.config.userSyncIntervalDays)) return

    const row = await this.profiles.ensure(profile)
    const profileStale = isStale(row.lastSync, this.config.userSyncIntervalDays)
    if (!profileStale || row.syncing) {
      // Someone else's scan handled (or is handling) the refresh — adopt it.
      await this.perms.markSynced(email)
      return
    }

    const acquired = await this.profiles.tryAcquireLock(profile)
    if (!acquired) {
      // Lost the race to another concurrent request; adopt their scan.
      await this.perms.markSynced(email)
      return
    }

    this.queue.enqueue(profile, () => this.run(profile, session))
  }

  /**
   * Run a scan synchronously for the cold-start path (a brand-new profile
   * being seen for the first time). Caller is responsible for not blocking
   * a user request on this — wrap it in setImmediate / enqueue.
   */
  async kickoffNewProfile(session: Session, profile: ProfileTuple): Promise<void> {
    await this.profiles.ensure(profile)
    const acquired = await this.profiles.tryAcquireLock(profile)
    if (!acquired) return
    this.queue.enqueue(profile, () => this.run(profile, session))
  }

  private async run(profile: ProfileTuple, session: Session): Promise<void> {
    const email = session.username ?? '<unknown>'
    const tokens = new DelegatedGraphTokenProvider(session, this.sessions)
    // We track every code we successfully resolved in-memory so the final
    // sweep can drop codes the user has lost access to since the previous
    // scan. `pendingBatch` accumulates codes for the next flush; it's drained
    // every ACCESS_FLUSH_BATCH_SIZE rows so the chat filter sees new entries
    // in near real-time without paying for a DB roundtrip on every row.
    const seenCodes = new Set<string>()
    const pendingBatch: string[] = []
    const flushPending = async () => {
      if (pendingBatch.length === 0) return
      await this.profiles.addAllowedCodes(profile, pendingBatch)
      pendingBatch.length = 0
    }
    let fatalError: string | null = null

    try {
      const { listId } = await this.listSvc.resolveLocation(tokens)
      for await (const row of this.listSvc.iterateItems(tokens)) {
        const f = (row.fields ?? {}) as Record<string, unknown>
        const code = trim(f.Code)
        const version = trim(f.Ver)
        const title = trim(f.Title)
        const linkObj = f.Link
        const linkUrl =
          typeof linkObj === 'object' && linkObj && 'Url' in (linkObj as object)
            ? String((linkObj as { Url?: unknown }).Url ?? '')
            : typeof linkObj === 'string' ? linkObj : ''

        if (!code || !title || !linkUrl) continue

        const sourceMetadata: Record<string, unknown> = {
          title, code, version,
          date: trim(f.Date),
          distribution: trim(f.Distribution),
          link_url: linkUrl,
        }

        try {
          const resolved = await this.listSvc.resolveByCode(tokens, { code, title, version })
          if (!resolved) {
            // Strategy H couldn't resolve — treat as "this profile can't see it."
            continue
          }
          const buffer = await this.listSvc.downloadFile(tokens, resolved)
          await this.documents.upsertFromSharepointList({
            listId, code, version, title, sourceMetadata,
            file: { buffer, filename: resolved.name },
          })
          // Stream the allow-list update in small batches: chat filter picks
          // up each batch on its very next query, but we don't pay for a DB
          // roundtrip per row.
          pendingBatch.push(code)
          seenCodes.add(code)
          if (pendingBatch.length >= ACCESS_FLUSH_BATCH_SIZE) {
            await flushPending()
          }
        } catch (err) {
          // Transient Graph error — skip without recording the code. Next
          // scan will retry. Don't poison the allow-list with a no.
          console.warn(
            `[job-profile-sync ${profile.jobTitle}/${profile.department}] row failed for code=${code}:`,
            (err as Error).message?.slice(0, 200),
          )
        }
      }
      // Flush any leftover codes from the last partial batch before sweeping.
      await flushPending()
      // Final sweep: drop codes the previous scan recorded that aren't in
      // this scan's set. Skipped on fatal error so a half-finished run can't
      // shrink the allow-list arbitrarily.
      await this.profiles.pruneStaleAccess(profile, seenCodes)
    } catch (err) {
      fatalError = (err as Error).message?.slice(0, 500) ?? 'unknown error'
      console.error(
        `[job-profile-sync ${profile.jobTitle}/${profile.department}] fatal:`,
        err,
      )
    } finally {
      await this.profiles.releaseLock(profile, {
        success: !fatalError,
        email,
        error: fatalError,
      })
      // Whether or not the scan succeeded, mark the triggering user's lastSync
      // so we don't immediately re-evaluate them on the next request.
      if (session.username) {
        await this.perms.markSynced(session.username, fatalError).catch(() => {})
      }
    }
  }
}

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isStale(lastSync: Date | null, intervalDays: number): boolean {
  if (!lastSync) return true
  return Date.now() - lastSync.getTime() >= intervalDays * 24 * 60 * 60 * 1000
}
