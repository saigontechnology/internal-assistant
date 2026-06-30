import { AppConfig } from '../config/app-config.service.js'
import { DocumentsService, type SharepointUpsertOutcome } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DistributionListService } from './distribution-list.service.js'
import { GraphTokenProvider } from './graph-token-provider.js'
import {
  SharepointListService,
  type RegistryRow,
  type ResolvedTargetList,
} from './sharepoint-list.service.js'

export interface PerListCounters {
  seen: number
  ingested: number
  updated: number
  skipped: number
  pending: number
  removed: number
  failed: number
}

export interface PerListSummary {
  distributionListId: string
  displayName: string
  targetListId: string | null
  status: 'ok' | 'partial' | 'error' | 'unresolvable'
  counters: PerListCounters
  itemErrors: { code?: string; rowId?: string; error: string }[]
  fatalError?: string
}

export interface SyncRunSummary {
  triggeredBy: 'manual' | 'cron'
  startedAt: Date
  finishedAt: Date
  durationMs: number
  status: 'ok' | 'partial' | 'error'
  totals: {
    registryRows: number
    distributionListsResolved: number
    distributionListsUnresolved: number
    distributionListsOrphaned: number
    seen: number
    ingested: number
    updated: number
    skipped: number
    pending: number
    removed: number
    failed: number
  }
  lists: PerListSummary[]
  fatalError?: string
}

const MAX_ERRORS_PER_LIST = 50

/**
 * Orchestrates a registry-driven sync. See docs/multi-list-watcher-plan.md §6.
 *
 *   1. Read the registry list under SHAREPOINT_SITE_PATH.
 *   2. Upsert distribution_lists rows (one per registry row).
 *   3. Dedupe targets — multiple registry rows pointing at the same list
 *      sync once; their counters mirror the single underlying sync.
 *   4. Per resolved target: iterate items, apply Strategy H, write resources
 *      and distribution_list_items.
 *   5. Demote registry orphans + orphaned target resources.
 *
 * One global mutex; lists processed sequentially to stay under Graph quotas.
 */
export class ListWatcherService {
  private running = false
  private lastRun: SyncRunSummary | null = null
  private currentStart: Date | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly listSvc: SharepointListService,
    private readonly documents: DocumentsService,
    private readonly distributionLists: DistributionListService,
    private readonly config: AppConfig,
  ) {}

  isRunning(): boolean { return this.running }
  getLastRun(): SyncRunSummary | null { return this.lastRun }
  getCurrentStart(): Date | null { return this.currentStart }

  async sync(tokens: GraphTokenProvider, triggeredBy: 'manual' | 'cron'): Promise<SyncRunSummary> {
    if (this.running) throw new AlreadyRunningError()
    this.running = true
    this.currentStart = new Date()

    const startedAt = this.currentStart
    const perList: PerListSummary[] = []
    let registryRowsCount = 0
    let resolvedCount = 0
    let unresolvedCount = 0
    let orphanCount = 0
    let fatalError: string | undefined

    try {
      const registry = await this.listSvc.resolveRegistry(tokens)
      registryRowsCount = registry.rows.length

      // Group registry rows by their resolved targetListId. Multiple rows may
      // point at the same list (intentionally — e.g. distribution to two
      // departments) and we want to sync that target once but reflect the
      // outcome onto every registry row that names it.
      const groups = new Map<string, {
        target: ResolvedTargetList
        distributionListIds: string[]
        registryRows: RegistryRow[]
      }>()

      for (const row of registry.rows) {
        const target = await this.listSvc.resolveTargetList(tokens, row.listUrl)
        const upserted = await this.distributionLists.upsertRegistryRow({
          registryListId: registry.registryListId,
          row,
          target,
          syncStartedAt: startedAt,
        })

        if (!target) {
          unresolvedCount++
          perList.push({
            distributionListId: upserted.id,
            displayName: row.displayName,
            targetListId: null,
            status: 'unresolvable',
            counters: { seen: 0, ingested: 0, updated: 0, skipped: 0, pending: 0, removed: 0, failed: 0 },
            itemErrors: [],
            fatalError: 'Link could not be resolved to a SharePoint list',
          })
          continue
        }

        const key = target.listId
        const group = groups.get(key)
        if (group) {
          group.distributionListIds.push(upserted.id)
          group.registryRows.push(row)
        } else {
          groups.set(key, {
            target,
            distributionListIds: [upserted.id],
            registryRows: [row],
          })
        }
      }

      resolvedCount = groups.size

      for (const group of groups.values()) {
        const summary = await this.syncOneTarget(tokens, group)
        perList.push(...summary)
      }

      // Reconcile registry-side orphans (rows removed from the registry since
      // last run). Their target resources will already be demoted by the
      // documents-service sweep below; this just marks the dist_lists row.
      orphanCount = await this.distributionLists.demoteOrphanRegistryRows(startedAt)

      // Cross-list orphan demote: any synced resource whose listId isn't in
      // this run's target set gets dropped to pending_access (target lists
      // that disappeared from the registry, or whose registry row no longer
      // resolves them).
      const liveTargetIds = new Set<string>(Array.from(groups.values()).map((g) => g.target.listId))
      await this.documents.demoteOrphanedSharepointRows(liveTargetIds)
    } catch (err) {
      fatalError = (err as Error).message
    } finally {
      this.running = false
      this.currentStart = null
    }

    const finishedAt = new Date()

    const totals: SyncRunSummary['totals'] = {
      registryRows: registryRowsCount,
      distributionListsResolved: resolvedCount,
      distributionListsUnresolved: unresolvedCount,
      distributionListsOrphaned: orphanCount,
      seen: 0, ingested: 0, updated: 0, skipped: 0, pending: 0, removed: 0, failed: 0,
    }
    for (const s of perList) {
      totals.seen += s.counters.seen
      totals.ingested += s.counters.ingested
      totals.updated += s.counters.updated
      totals.skipped += s.counters.skipped
      totals.pending += s.counters.pending
      totals.removed += s.counters.removed
      totals.failed += s.counters.failed
    }

    let status: SyncRunSummary['status']
    if (fatalError) {
      status = 'error'
    } else if (perList.length > 0 && perList.every((s) => s.status === 'error')) {
      status = 'error'
    } else if (
      perList.some((s) => s.status !== 'ok') ||
      unresolvedCount > 0 ||
      orphanCount > 0
    ) {
      status = 'partial'
    } else {
      status = 'ok'
    }

    const summary: SyncRunSummary = {
      triggeredBy, startedAt, finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status, totals, lists: perList, fatalError,
    }
    this.lastRun = summary
    return summary
  }

  /**
   * Sync one target list. Returns one PerListSummary per registry row that
   * resolved to this target (they all share the underlying counters but each
   * needs its own summary entry for the UI).
   */
  private async syncOneTarget(
    tokens: GraphTokenProvider,
    group: { target: ResolvedTargetList; distributionListIds: string[]; registryRows: RegistryRow[] },
  ): Promise<PerListSummary[]> {
    const { target, distributionListIds, registryRows } = group
    const listId = target.listId
    const seenAt = new Date()
    const counters: PerListCounters = {
      seen: 0, ingested: 0, updated: 0, skipped: 0, pending: 0, removed: 0, failed: 0,
    }
    const itemErrors: PerListSummary['itemErrors'] = []
    let fatalError: string | undefined

    // Track which previous distribution_list_items rows we still see, so
    // we can drop the orphans at the end of the list.
    const liveCodes = new Set<string>()

    try {
      await this.prisma.watcherState.upsert({
        where: { listId },
        update: { lastStatus: 'running' },
        create: { listId, lastStatus: 'running' },
      })

      // Pre-fetch existing resource state for this listId (warm-path skip).
      const existing = await this.prisma.resource.findMany({
        where: { sharepointListId: listId, sharepointCode: { not: null } },
        select: { id: true, sharepointCode: true, sharepointVersion: true, syncStatus: true },
      })
      const existingByCode = new Map<string, { id: string; version: string | null; status: string }>()
      for (const r of existing) {
        if (r.sharepointCode) {
          existingByCode.set(r.sharepointCode, {
            id: r.id,
            version: r.sharepointVersion,
            status: r.syncStatus,
          })
        }
      }
      const skippedCodes: string[] = []

      // Incremental sync window — when configured, only request rows modified
      // since (lastSyncedAt - windowDays). The reconcile pass still happens
      // via removeStaleSharepointRows which is keyed on the live-code set —
      // see plan §6.1 for the trade-off.
      const windowDays = this.config.sharepointRegistryIncrementalWindowDays
      const incremental = windowDays > 0 ? await this.computeIncrementalSince(distributionListIds, windowDays) : undefined

      for await (const row of this.listSvc.iterateItemsAt(tokens, target.siteId, listId, {
        modifiedSince: incremental,
      })) {
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
          pushErr(itemErrors, { rowId: row.id, error: 'missing Code' })
          continue
        }
        if (!linkUrl) {
          counters.failed++
          pushErr(itemErrors, { code, error: 'missing Link.Url' })
          continue
        }
        liveCodes.add(code)

        const prior = existingByCode.get(code)
        if (prior && prior.status === 'synced' && prior.version === version) {
          counters.skipped++
          skippedCodes.push(code)
          // Mirror onto distribution_list_items (status preserved).
          await this.mirrorItem(distributionListIds, {
            resourceId: prior.id, code, title, version,
            syncStatus: 'synced', syncError: null, seenAt,
          })
          continue
        }

        const sourceMetadata: Record<string, unknown> = {
          title, code, version,
          date: trim(f.Date),
          distribution: trim(f.Distribution),
          link_url: linkUrl,
        }

        try {
          let outcome: SharepointUpsertOutcome
          if (!title) {
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
            } else {
              const buffer = await this.listSvc.downloadFile(tokens, resolved)
              outcome = await this.documents.upsertFromSharepointList({
                listId, code, version, title, sourceMetadata,
                file: { buffer, filename: resolved.name },
              })
            }
          }
          this.applyOutcome(counters, outcome)

          // Look up the (possibly new) resource id to attach to the mirror row.
          const after = await this.prisma.resource.findUnique({
            where: { sp_code_uk: { sharepointListId: listId, sharepointCode: code } },
            select: { id: true, syncStatus: true, syncError: true },
          })
          await this.mirrorItem(distributionListIds, {
            resourceId: after?.id ?? null,
            code, title, version,
            syncStatus: after?.syncStatus ?? 'failed_resolve',
            syncError: after?.syncError ?? null,
            seenAt,
          })
        } catch (err) {
          counters.failed++
          pushErr(itemErrors, { code, error: (err as Error).message.slice(0, 300) })
          try {
            await this.documents.upsertFromSharepointList({
              listId, code, version, title, sourceMetadata,
              status: 'failed_resolve', error: (err as Error).message.slice(0, 500),
            })
            await this.mirrorItem(distributionListIds, {
              resourceId: null, code, title, version,
              syncStatus: 'failed_resolve',
              syncError: (err as Error).message.slice(0, 500), seenAt,
            })
          } catch { /* already counted as failed */ }
        }
      }

      // Warm-path skip bookkeeping (single batched UPDATE).
      if (skippedCodes.length > 0) {
        await this.prisma.resource.updateMany({
          where: { sharepointListId: listId, sharepointCode: { in: skippedCodes } },
          data: { lastSyncAttempt: seenAt, sharepointPendingVersion: null },
        })
      }

      // Per-list reconcile — remove resources that disappeared from the live set.
      counters.removed = await this.documents.removeStaleSharepointRows(listId, liveCodes)

      // Mirror reconcile for every distribution list pointing at this target.
      for (const dlId of distributionListIds) {
        await this.distributionLists.removeOrphanItems(dlId, liveCodes)
      }
    } catch (err) {
      fatalError = (err as Error).message
    }

    const status: PerListSummary['status'] =
      fatalError ? 'error'
        : (counters.failed > 0 || counters.pending > 0) ? 'partial'
        : 'ok'

    // Persist counters onto the WatcherState row (one per target listId).
    try {
      await this.prisma.watcherState.upsert({
        where: { listId },
        create: {
          listId,
          lastRunAt: new Date(),
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
          lastRunAt: new Date(),
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
    } catch { /* swallow */ }

    // Mirror outcome onto every distribution_lists row pointing at this target.
    for (const dlId of distributionListIds) {
      try {
        await this.distributionLists.markRegistryRowSyncResult({
          distributionListId: dlId,
          status,
          counters: {
            synced: counters.ingested + counters.updated + counters.skipped,
            pending: counters.pending,
            failed: counters.failed,
            removed: counters.removed,
          },
          fatalError,
        })
      } catch { /* swallow */ }
    }

    return distributionListIds.map((id, idx) => ({
      distributionListId: id,
      displayName: registryRows[idx]?.displayName ?? target.displayName,
      targetListId: target.listId,
      status,
      counters,
      itemErrors,
      fatalError,
    }))
  }

  /**
   * Compute the cutoff timestamp for an incremental sync. Returns undefined
   * when any participating distribution list hasn't been synced before (full
   * sync required for those).
   */
  private async computeIncrementalSince(
    distributionListIds: string[],
    windowDays: number,
  ): Promise<Date | undefined> {
    const rows = await this.prisma.distributionList.findMany({
      where: { id: { in: distributionListIds } },
      select: { lastSyncedAt: true },
    })
    if (rows.length === 0) return undefined
    if (rows.some((r) => r.lastSyncedAt === null)) return undefined
    const oldest = rows.reduce<Date>(
      (acc, r) => (acc.getTime() < r.lastSyncedAt!.getTime() ? acc : r.lastSyncedAt!),
      rows[0].lastSyncedAt!,
    )
    return new Date(oldest.getTime() - windowDays * 24 * 60 * 60 * 1000)
  }

  private async mirrorItem(
    distributionListIds: string[],
    args: {
      resourceId: string | null
      code: string
      title: string
      version: string
      syncStatus: string
      syncError: string | null
      seenAt: Date
    },
  ): Promise<void> {
    for (const dlId of distributionListIds) {
      try {
        await this.distributionLists.upsertItem({
          distributionListId: dlId,
          ...args,
        })
      } catch (err) {
        console.warn(
          `[list-watcher] mirrorItem failed for code=${args.code} dlId=${dlId}:`,
          (err as Error).message?.slice(0, 200),
        )
      }
    }
  }

  private applyOutcome(counters: PerListCounters, o: SharepointUpsertOutcome): void {
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
  list: PerListSummary['itemErrors'],
  err: PerListSummary['itemErrors'][number],
): void {
  if (list.length >= MAX_ERRORS_PER_LIST) return
  list.push(err)
}
