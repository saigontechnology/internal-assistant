import { DocumentsService, type SharepointUpsertOutcome } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { GraphTokenProvider } from './graph-token-provider.js'
import { SharepointListService } from './sharepoint-list.service.js'

export interface SyncRunSummary {
  listId: string
  triggeredBy: 'manual' | 'cron'
  startedAt: Date
  finishedAt: Date
  durationMs: number
  status: 'ok' | 'partial' | 'error'
  counters: {
    seen: number
    ingested: number
    updated: number
    skipped: number
    pending: number
    removed: number
    failed: number
  }
  /** Truncated; only the first N per-item errors are kept. */
  itemErrors: { code?: string; rowId?: string; error: string }[]
  /** Set when status='error' (the sync itself failed, not per-row). */
  fatalError?: string
}

/**
 * Orchestrates one SharePoint List sync pass. See docs/sharepoint-list-watcher-plan.md §8.
 *
 * Single in-process mutex guards against overlapping runs (a manual sync that
 * fires while the cron is still working returns 409 from the controller).
 * For single-instance self-hosted that's enough; switch to a Postgres
 * advisory lock if we ever scale.
 */
export class ListWatcherService {
  private running = false

  /** Latest finished run, surfaced via GET /api/sync/status. */
  private lastRun: SyncRunSummary | null = null
  private currentStart: Date | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly listSvc: SharepointListService,
    private readonly documents: DocumentsService,
  ) {}

  isRunning(): boolean { return this.running }
  getLastRun(): SyncRunSummary | null { return this.lastRun }
  getCurrentStart(): Date | null { return this.currentStart }

  /**
   * Run one full sync against the configured list. Throws AlreadyRunningError
   * if a sync is already in progress.
   */
  async sync(tokens: GraphTokenProvider, triggeredBy: 'manual' | 'cron'): Promise<SyncRunSummary> {
    if (this.running) throw new AlreadyRunningError()
    this.running = true
    this.currentStart = new Date()

    const startedAt = this.currentStart
    const counters = { seen: 0, ingested: 0, updated: 0, skipped: 0, pending: 0, removed: 0, failed: 0 }
    const itemErrors: SyncRunSummary['itemErrors'] = []
    const MAX_ERRORS = 50

    let listId = 'unknown'
    let fatalError: string | undefined

    try {
      const loc = await this.listSvc.resolveLocation(tokens)
      listId = loc.listId

      await this.prisma.watcherState.upsert({
        where: { listId },
        update: { lastStatus: 'running' },
        create: { listId, lastStatus: 'running' },
      })

      const liveCodes = new Set<string>()

      for await (const row of this.listSvc.iterateItems(tokens)) {
        counters.seen++
        const f = (row.fields ?? {}) as Record<string, unknown>
        const code = trim(f.Code)
        const version = trim(f.Ver)
        const title = trim(f.Title)
        const linkObj = f.Link
        const linkUrl =
          typeof linkObj === 'object' && linkObj && 'Url' in (linkObj as object)
            ? String((linkObj as { Url?: unknown }).Url ?? '')
            : typeof linkObj === 'string' ? linkObj : ''

        if (!code) {
          counters.failed++
          pushErr(itemErrors, { rowId: row.id, error: 'missing Code' }, MAX_ERRORS)
          continue
        }
        if (!linkUrl) {
          counters.failed++
          pushErr(itemErrors, { code, error: 'missing Link.Url' }, MAX_ERRORS)
          continue
        }
        liveCodes.add(code)

        const sourceMetadata: Record<string, unknown> = {
          title, code, version,
          date: trim(f.Date),
          distribution: trim(f.Distribution),
          link_url: linkUrl,
        }

        try {
          let outcome: SharepointUpsertOutcome
          if (!title) {
            // Title is what Strategy H searches against. Without it we can't resolve.
            outcome = await this.documents.upsertFromSharepointList({
              listId, code, version, title: code, sourceMetadata,
              status: 'failed_resolve', error: 'list row has no Title',
            })
          } else {
            const resolved = await this.listSvc.resolveByCode(tokens, { code, title, version })
            if (!resolved) {
              outcome = await this.documents.upsertFromSharepointList({
                listId, code, version, title, sourceMetadata,
                status: 'pending_access',
                error: 'predicted-filename search returned no matching driveItem',
              })
            } else if (await this.documents.isAlreadySyncedAtVersion(listId, code, version)) {
              // Save a Graph download: another caller already synced this exact
              // (code, version). Case 1 in upsertFromSharepointList would skip
              // anyway after parsing/embedding nothing, but we'd still pay the
              // bytes. Short-circuit here.
              outcome = { kind: 'skipped' }
            } else {
              const buffer = await this.listSvc.downloadFile(tokens, resolved)
              outcome = await this.documents.upsertFromSharepointList({
                listId, code, version, title, sourceMetadata,
                file: { buffer, filename: resolved.name },
              })
            }
          }
          this.applyOutcome(counters, outcome)
        } catch (err) {
          counters.failed++
          pushErr(itemErrors, { code, error: (err as Error).message.slice(0, 300) }, MAX_ERRORS)
          // Best-effort: record the failure on the resource row too so it's visible in the UI.
          try {
            await this.documents.upsertFromSharepointList({
              listId, code, version, title, sourceMetadata,
              status: 'failed_resolve', error: (err as Error).message.slice(0, 500),
            })
          } catch { /* ignore — already counted as failed */ }
        }
      }

      // Reconcile — anything in DB but no longer in the live list disappears.
      counters.removed = await this.documents.removeStaleSharepointRows(listId, liveCodes)
    } catch (err) {
      fatalError = (err as Error).message
    } finally {
      this.running = false
      this.currentStart = null
    }

    const finishedAt = new Date()
    const status: SyncRunSummary['status'] =
      fatalError ? 'error'
        : (counters.failed > 0 || counters.pending > 0) ? 'partial'
        : 'ok'

    const summary: SyncRunSummary = {
      listId, triggeredBy, startedAt, finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status, counters, itemErrors, fatalError,
    }

    // Persist run summary (best-effort — never let DB write failure mask the real sync result).
    try {
      await this.prisma.watcherState.upsert({
        where: { listId },
        create: {
          listId,
          lastRunAt: finishedAt,
          lastStatus: status,
          lastError: fatalError ?? (itemErrors.length ? JSON.stringify(itemErrors).slice(0, 4000) : null),
          itemsSeen: counters.seen,
          itemsIngested: counters.ingested,
          itemsUpdated: counters.updated,
          itemsSkipped: counters.skipped,
          itemsPending: counters.pending,
          itemsRemoved: counters.removed,
          itemsFailed: counters.failed,
        },
        update: {
          lastRunAt: finishedAt,
          lastStatus: status,
          lastError: fatalError ?? (itemErrors.length ? JSON.stringify(itemErrors).slice(0, 4000) : null),
          itemsSeen: counters.seen,
          itemsIngested: counters.ingested,
          itemsUpdated: counters.updated,
          itemsSkipped: counters.skipped,
          itemsPending: counters.pending,
          itemsRemoved: counters.removed,
          itemsFailed: counters.failed,
        },
      })
    } catch {
      // swallow; the SyncRunSummary is still returned
    }

    this.lastRun = summary
    return summary
  }

  private applyOutcome(
    counters: SyncRunSummary['counters'],
    o: SharepointUpsertOutcome,
  ): void {
    switch (o.kind) {
      case 'ingested': counters.ingested++; break
      case 'updated':  counters.updated++; break
      case 'skipped':  counters.skipped++; break
      case 'pending':  counters.pending++; break
      case 'failed':   counters.failed++; break
    }
  }
}

export class AlreadyRunningError extends Error {
  constructor() { super('A sync is already running') }
}

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function pushErr(
  list: SyncRunSummary['itemErrors'],
  err: SyncRunSummary['itemErrors'][number],
  max: number,
): void {
  if (list.length >= max) return
  list.push(err)
}
