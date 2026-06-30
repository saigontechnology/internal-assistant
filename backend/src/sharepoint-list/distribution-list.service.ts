import { nanoid } from 'nanoid'
import { PrismaService } from '../prisma/prisma.service.js'
import type { RegistryRow, ResolvedTargetList } from './sharepoint-list.service.js'

/**
 * Reads and writes the registry-driven tables:
 *   distribution_lists      — one row per registry row
 *   distribution_list_items — per-doc intent
 *   job_profile_distribution_lists — profile ↔ list edges
 *
 * Kept separate from DocumentsService so the registry plumbing doesn't bleed
 * into the file-ingestion pipeline.
 */
export class DistributionListService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Registry rows ────────────────────────────────────────────────

  /**
   * Upsert one registry row. Always bumps `last_seen_at` to mark the row as
   * present in the current run; the orphan sweep at end-of-run uses this to
   * decide what disappeared from the registry.
   *
   * `target` is null when the URL hasn't been (or can't be) resolved.
   */
  async upsertRegistryRow(args: {
    registryListId: string
    row: RegistryRow
    target: ResolvedTargetList | null
    syncStartedAt: Date
  }): Promise<{ id: string }> {
    const { registryListId, row, target, syncStartedAt } = args
    const existing = await this.prisma.distributionList.findUnique({
      where: {
        registry_uk: {
          registryListId,
          registryItemId: row.registryItemId,
        },
      },
      select: { id: true },
    })

    if (existing) {
      await this.prisma.distributionList.update({
        where: { id: existing.id },
        data: {
          displayName: row.displayName,
          note: row.note,
          listUrl: row.listUrl,
          siteId: target?.siteId ?? null,
          targetListId: target?.listId ?? null,
          lastSeenAt: syncStartedAt,
          lastSyncStatus: target ? 'pending' : 'unresolvable',
          lastSyncError: target ? null : 'could not resolve Link to a SharePoint list',
        },
      })
      return existing
    }
    const created = await this.prisma.distributionList.create({
      data: {
        id: nanoid(12),
        registryListId,
        registryItemId: row.registryItemId,
        displayName: row.displayName,
        note: row.note,
        listUrl: row.listUrl,
        siteId: target?.siteId ?? null,
        targetListId: target?.listId ?? null,
        lastSeenAt: syncStartedAt,
        lastSyncStatus: target ? 'pending' : 'unresolvable',
        lastSyncError: target ? null : 'could not resolve Link to a SharePoint list',
      },
      select: { id: true },
    })
    return created
  }

  /**
   * After a registry-row upsert *and* the per-list sync finishes, write the
   * outcome onto the distribution_lists row so the UI has counters without
   * having to join against resources.
   */
  async markRegistryRowSyncResult(args: {
    distributionListId: string
    status: 'ok' | 'partial' | 'error'
    counters: {
      synced: number
      pending: number
      failed: number
      removed: number
    }
    fatalError?: string
  }): Promise<void> {
    await this.prisma.distributionList.update({
      where: { id: args.distributionListId },
      data: {
        lastSyncedAt: new Date(),
        lastSyncStatus: args.status,
        lastSyncError: args.fatalError ?? null,
        itemsSynced: args.counters.synced,
        itemsPending: args.counters.pending,
        itemsFailed: args.counters.failed,
        itemsRemoved: args.counters.removed,
      },
    })
  }

  /**
   * Demote distribution_lists rows that weren't seen this run. Their target
   * resources also drop to pending_access via DocumentsService — this just
   * marks the registry entry as gone for UI purposes.
   *
   * Returns the demoted count.
   */
  async demoteOrphanRegistryRows(syncStartedAt: Date): Promise<number> {
    const result = await this.prisma.distributionList.updateMany({
      where: {
        lastSeenAt: { lt: syncStartedAt },
        lastSyncStatus: { not: 'removed' },
      },
      data: {
        lastSyncStatus: 'removed',
        lastSyncError: 'registry row no longer present',
      },
    })
    return result.count
  }

  /** Listed by the API; used by the Sidebar's Layer 1. */
  async listAllForApi(): Promise<
    {
      id: string
      displayName: string
      note: string | null
      listUrl: string
      lastSyncedAt: Date | null
      lastSyncStatus: string
      lastSyncError: string | null
      counters: { synced: number; pending: number; failed: number; removed: number }
    }[]
  > {
    const rows = await this.prisma.distributionList.findMany({
      orderBy: [{ lastSyncStatus: 'asc' }, { displayName: 'asc' }],
    })
    return rows.map((r) => ({
      id: r.id,
      displayName: r.displayName,
      note: r.note,
      listUrl: r.listUrl,
      lastSyncedAt: r.lastSyncedAt,
      lastSyncStatus: r.lastSyncStatus,
      lastSyncError: r.lastSyncError,
      counters: {
        synced: r.itemsSynced,
        pending: r.itemsPending,
        failed: r.itemsFailed,
        removed: r.itemsRemoved,
      },
    }))
  }

  async getByIdForApi(id: string) {
    return this.prisma.distributionList.findUnique({ where: { id } })
  }

  // ── Per-doc items ────────────────────────────────────────────────

  /**
   * Mirror one document's state into distribution_list_items. Called from
   * the watcher every time a row is processed (successful ingest OR a
   * deliberate skip OR a recorded failure). The `resourceId` is the
   * resources.id when we have one; null for metadata-only rows.
   */
  async upsertItem(args: {
    distributionListId: string
    resourceId: string | null
    code: string
    title: string
    version: string
    syncStatus: string
    syncError: string | null
    seenAt: Date
  }): Promise<void> {
    await this.prisma.distributionListItem.upsert({
      where: {
        distribution_code_uk: {
          distributionListId: args.distributionListId,
          sharepointCode: args.code,
        },
      },
      create: {
        id: nanoid(12),
        distributionListId: args.distributionListId,
        resourceId: args.resourceId,
        sharepointCode: args.code,
        sharepointTitle: args.title,
        sharepointVersion: args.version,
        syncStatus: args.syncStatus,
        syncError: args.syncError,
        lastSeenAt: args.seenAt,
      },
      update: {
        resourceId: args.resourceId,
        sharepointTitle: args.title,
        sharepointVersion: args.version,
        syncStatus: args.syncStatus,
        syncError: args.syncError,
        lastSeenAt: args.seenAt,
      },
    })
  }

  /**
   * Drop distribution_list_items for codes that disappeared from a list.
   * Returns the deleted count.
   */
  async removeOrphanItems(distributionListId: string, liveCodes: Set<string>): Promise<number> {
    const live = Array.from(liveCodes)
    const result = await this.prisma.distributionListItem.deleteMany({
      where: {
        distributionListId,
        ...(live.length > 0 ? { sharepointCode: { notIn: live } } : {}),
      },
    })
    return result.count
  }

  async listItemsForApi(
    distributionListId: string,
    opts: { take?: number; cursor?: string } = {},
  ) {
    const take = Math.min(Math.max(opts.take ?? 100, 1), 500)
    return this.prisma.distributionListItem.findMany({
      where: { distributionListId },
      orderBy: { sharepointCode: 'asc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    })
  }

  // ── Profile ↔ list edges ────────────────────────────────────────

  /** Record that `profile` had access to this distribution list during a scan. */
  async upsertProfileEdge(args: {
    jobTitle: string
    department: string
    distributionListId: string
  }): Promise<void> {
    const now = new Date()
    await this.prisma.jobProfileDistributionList.upsert({
      where: {
        jobTitle_department_distributionListId: {
          jobTitle: args.jobTitle,
          department: args.department,
          distributionListId: args.distributionListId,
        },
      },
      create: {
        jobTitle: args.jobTitle,
        department: args.department,
        distributionListId: args.distributionListId,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: { lastSeenAt: now },
    })
  }

  /**
   * Remove profile→list edges that this scan didn't refresh. Called once at
   * the end of a job-profile scan with `syncStartedAt` from before the scan;
   * any edge whose lastSeenAt is older is considered stale.
   */
  async pruneStaleProfileEdges(args: {
    jobTitle: string
    department: string
    syncStartedAt: Date
  }): Promise<number> {
    const result = await this.prisma.jobProfileDistributionList.deleteMany({
      where: {
        jobTitle: args.jobTitle,
        department: args.department,
        lastSeenAt: { lt: args.syncStartedAt },
      },
    })
    return result.count
  }
}
