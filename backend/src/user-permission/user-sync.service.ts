import type { Session } from '@prisma/client'
import { AppConfig } from '../config/app-config.service.js'
import { SessionService } from '../auth/session.service.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DelegatedGraphTokenProvider } from '../sharepoint-list/graph-token-provider.js'
import { SharepointListService } from '../sharepoint-list/sharepoint-list.service.js'
import { UserPermissionService } from './user-permission.service.js'
import { UserResourcePermissionService } from './user-resource-permission.service.js'
import { UserSyncQueue } from './user-sync.queue.js'

/**
 * Runs one per-user sync. For each row in the SharePoint list:
 *
 *  - Resolve the driveItem with the user's delegated Graph token.
 *  - If the cache says we know this user's verdict for this code AND the
 *    entry is within the TTL window, reuse it (no Graph call).
 *  - If resolution succeeds: mark authorized, ingest into the shared index
 *    when the shared row is missing/stale/failed/at-older-version.
 *  - If resolution returns null (search miss): mark unauthorized.
 *  - If resolution throws: leave the cache untouched, record the row error
 *    but don't permanently lock the user out.
 *
 * Writes shared `resources` + `embeddings` via DocumentsService.upsertFromSharepointList;
 * never removes rows (stale cleanup belongs to the global admin sync).
 */
export class UserSyncService {
  /** Heal a `syncing_started_at` older than 30 min — a crashed/timed-out job. */
  static readonly STUCK_THRESHOLD_MS = 30 * 60 * 1000

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly listSvc: SharepointListService,
    private readonly documents: DocumentsService,
    private readonly perms: UserPermissionService,
    private readonly cache: UserResourcePermissionService,
    private readonly queue: UserSyncQueue,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Enqueue a per-user sync for the caller's session. Idempotent: returns
   * 'already_present' when the same user already has a job in flight or queued.
   */
  enqueueFor(session: Session): 'started' | 'queued' | 'already_present' {
    const email = session.username
    if (!email) {
      throw new Error('Session has no username; cannot enqueue per-user sync')
    }
    const tokens = new DelegatedGraphTokenProvider(session, this.sessions)
    return this.queue.enqueue(email, () => this.run(email, tokens))
  }

  /** The actual job. Always resolves; persists its own error state on the row. */
  private async run(
    email: string,
    tokens: DelegatedGraphTokenProvider,
  ): Promise<void> {
    await this.perms.ensure(email)
    await this.perms.markRunning(email, null)

    const ttlMs = this.config.userPermCacheTtlDays * 24 * 60 * 60 * 1000
    const cacheCutoff = new Date(Date.now() - ttlMs)

    let cacheMap: Map<string, { authorized: boolean; checkedAt: Date }>
    let fatalError: string | null = null
    const liveCodes = new Set<string>()

    try {
      cacheMap = await this.cache.getMap(email)

      // Buffer the list up-front so we know the total row count before we
      // start processing. The list is bounded (~375 rows) so this is cheap;
      // the benefit is that the UI can show a real percentage from row 1.
      const rows: import('../sharepoint-list/sharepoint-list.service.js').ListRow[] = []
      for await (const r of this.listSvc.iterateItems(tokens)) rows.push(r)
      await this.perms.updateProgress(email, 0, rows.length)

      let seen = 0
      for (const row of rows) {
        seen++
        const f = (row.fields ?? {}) as Record<string, unknown>
        const code = trim(f.Code)
        const version = trim(f.Ver)
        const title = trim(f.Title)
        const linkObj = f.Link
        const linkUrl =
          typeof linkObj === 'object' && linkObj && 'Url' in (linkObj as object)
            ? String((linkObj as { Url?: unknown }).Url ?? '')
            : typeof linkObj === 'string' ? linkObj : ''

        if (!code || !title || !linkUrl) {
          // Row is unusable — skip without affecting the user's cache.
          await this.perms.updateProgress(email, seen, rows.length)
          continue
        }
        liveCodes.add(code)

        const sourceMetadata: Record<string, unknown> = {
          title, code, version,
          date: trim(f.Date),
          distribution: trim(f.Distribution),
          link_url: linkUrl,
        }

        // Cache hit within TTL — reuse the verdict, no Graph call. If the
        // cached verdict is "authorized" we still need to ensure the shared
        // row exists; check the resources table cheaply.
        const cached = cacheMap.get(code)
        if (cached && cached.checkedAt >= cacheCutoff) {
          if (cached.authorized) {
            await this.ensureSharedRowIfMissing(tokens, code, version, title, sourceMetadata)
          }
          await this.perms.updateProgress(email, seen, rows.length)
          continue
        }

        try {
          const resolved = await this.listSvc.resolveByCode(tokens, { code, title, version })
          if (!resolved) {
            // Strategy H couldn't find a matching driveItem for this user.
            // Treat as "unauthorized for this user" — matches the spec intent
            // even though it could be a name-divergence false positive.
            await this.cache.upsert(email, code, false)
          } else {
            // The user can see this file. Ingest into the shared index if it's
            // missing, stale, or failed for previous callers.
            const buffer = await this.listSvc.downloadFile(tokens, resolved)
            await this.documents.upsertFromSharepointList({
              listId: (await this.listSvc.resolveLocation(tokens)).listId,
              code, version, title, sourceMetadata,
              file: { buffer, filename: resolved.name },
            })
            await this.cache.upsert(email, code, true)
          }
        } catch (err) {
          // Transient Graph error — do not flip the user's cache, just log.
          // The next sync (weekly or manual) will retry this row.
          console.warn(
            `[user-sync ${email}] row failed for code=${code}:`,
            (err as Error).message?.slice(0, 200),
          )
        }

        await this.perms.updateProgress(email, seen, rows.length)
      }

      // After the loop, we know the live set. Drop cache rows whose code is no
      // longer in the list so the user doesn't carry around stale entries.
      await this.cache.removeStaleCodes(email, liveCodes)
    } catch (err) {
      fatalError = (err as Error).message?.slice(0, 500) ?? 'unknown error'
      console.error(`[user-sync ${email}] fatal:`, err)
    }

    const unauthorizedCodes = await this.cache.listUnauthorizedCodes(email)
    await this.perms.markFinished(email, unauthorizedCodes, fatalError)
  }

  /**
   * Cheap check: if the shared `resources` row for (listId, code) is missing
   * or not in 'synced' state, do a full resolve + download + ingest. We use
   * this on cache-hit-authorized rows so a previously-authorized user still
   * fills in gaps left by missing access from other callers.
   */
  private async ensureSharedRowIfMissing(
    tokens: DelegatedGraphTokenProvider,
    code: string,
    version: string,
    title: string,
    sourceMetadata: Record<string, unknown>,
  ): Promise<void> {
    const { listId } = await this.listSvc.resolveLocation(tokens)
    const existing = await this.prisma.resource.findUnique({
      where: { sp_code_uk: { sharepointListId: listId, sharepointCode: code } },
      select: { syncStatus: true, sharepointVersion: true },
    })
    if (
      existing &&
      existing.syncStatus === 'synced' &&
      existing.sharepointVersion === version
    ) {
      return
    }
    try {
      const resolved = await this.listSvc.resolveByCode(tokens, { code, title, version })
      if (!resolved) return // permission may have changed since the cache — leave for next full sync
      const buffer = await this.listSvc.downloadFile(tokens, resolved)
      await this.documents.upsertFromSharepointList({
        listId, code, version, title, sourceMetadata,
        file: { buffer, filename: resolved.name },
      })
    } catch (err) {
      console.warn(
        `[user-sync] ensureSharedRowIfMissing failed for code=${code}:`,
        (err as Error).message?.slice(0, 200),
      )
    }
  }
}

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
