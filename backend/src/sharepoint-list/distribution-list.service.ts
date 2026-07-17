import type { DistributionList } from '@prisma/client'
import { nanoid } from 'nanoid'
import { PrismaService } from '../prisma/prisma.service.js'
import type { ViewerAccess } from '../access/viewer-access.service.js'
import type { RegistryRow, ResolvedTargetList } from './sharepoint-list.service.js'

/**
 * Reads and writes the distribution-list tables:
 *   distribution_lists      — one row per document-source list (admin-owned)
 *   distribution_list_items — per-doc intent
 *   job_profile_distribution_lists — profile ↔ list edges
 *
 * The DB is the source of truth: rows are created and edited from the admin
 * portal, and the watcher iterates them directly. The legacy SharePoint
 * "registry list" survives only as a one-shot import (`upsertRegistryRow`,
 * called by the admin import endpoint).
 *
 * Kept separate from DocumentsService so the list plumbing doesn't bleed into
 * the file-ingestion pipeline.
 */
export class DistributionListService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Sync inputs ──────────────────────────────────────────────────

  /** The lists the watcher and the job-profile scan should walk. */
  async listForSync(): Promise<DistributionList[]> {
    return this.prisma.distributionList.findMany({
      where: { enabled: true },
      orderBy: { displayName: 'asc' },
    })
  }

  /**
   * Every target list that should stay live, i.e. the resolved targets of all
   * *enabled* rows.
   *
   * Callers feed this to `DocumentsService.demoteOrphanedSharepointRows`,
   * which demotes any synced resource whose list isn't in the set. It must be
   * derived from stored state, never from "what this run managed to resolve" —
   * a transient Graph failure, or a job-profile scan run by a user who can't
   * read a given site, would otherwise mass-demote healthy resources.
   */
  async liveTargetListIds(): Promise<Set<string>> {
    const rows = await this.prisma.distributionList.findMany({
      where: { enabled: true, targetListId: { not: null } },
      select: { targetListId: true },
    })
    return new Set(rows.map((r) => r.targetListId!))
  }

  /** Cache a freshly dereferenced target (or record that it didn't resolve). */
  async persistResolvedTarget(id: string, target: ResolvedTargetList | null): Promise<void> {
    await this.prisma.distributionList.update({
      where: { id },
      data: {
        siteId: target?.siteId ?? null,
        targetListId: target?.listId ?? null,
        ...(target
          ? {}
          : {
              lastSyncStatus: 'unresolvable',
              lastSyncError: 'could not resolve the list URL to a SharePoint list',
            }),
      },
    })
  }

  // ── Admin CRUD ───────────────────────────────────────────────────

  async create(args: {
    displayName: string
    note: string | null
    listUrl: string
    target: ResolvedTargetList | null
    createdByEmail: string | null
  }): Promise<DistributionList> {
    return this.prisma.distributionList.create({
      data: {
        id: nanoid(12),
        displayName: args.displayName,
        note: args.note,
        listUrl: args.listUrl,
        createdByEmail: args.createdByEmail,
        siteId: args.target?.siteId ?? null,
        targetListId: args.target?.listId ?? null,
        lastSyncStatus: args.target ? 'pending' : 'unresolvable',
        lastSyncError: args.target
          ? null
          : 'could not resolve the list URL to a SharePoint list',
      },
    })
  }

  /**
   * Patch an admin-editable field. When `target` is provided the URL changed
   * and was re-resolved; the sync counters reset because they describe a
   * different underlying list.
   */
  async update(
    id: string,
    args: {
      displayName?: string
      note?: string | null
      enabled?: boolean
      listUrl?: string
      target?: ResolvedTargetList | null
    },
  ): Promise<DistributionList> {
    const urlChanged = args.listUrl !== undefined
    return this.prisma.distributionList.update({
      where: { id },
      data: {
        ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(urlChanged
          ? {
              listUrl: args.listUrl,
              siteId: args.target?.siteId ?? null,
              targetListId: args.target?.listId ?? null,
              lastSyncStatus: args.target ? 'pending' : 'unresolvable',
              lastSyncError: args.target
                ? null
                : 'could not resolve the list URL to a SharePoint list',
              itemsSynced: 0,
              itemsPending: 0,
              itemsFailed: 0,
              itemsRemoved: 0,
            }
          : {}),
      },
    })
  }

  /** Cascades distribution_list_items + job_profile_distribution_lists. */
  async remove(id: string): Promise<void> {
    await this.prisma.distributionList.delete({ where: { id } })
  }

  /**
   * Duplicate check for create/update. Two rows may deliberately point at the
   * same target (e.g. one list distributed to two departments), so this only
   * blocks an identical URL — not an identical target.
   */
  async findByListUrl(listUrl: string, excludeId?: string): Promise<DistributionList | null> {
    return this.prisma.distributionList.findFirst({
      where: {
        listUrl,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    })
  }

  // ── Legacy registry import (one-shot) ───────────────────────────

  /**
   * Upsert one row of the legacy SharePoint registry list. Only reachable via
   * `POST /api/admin/distribution-lists/import-registry`, which lifts an
   * existing registry into the DB once so a deployment can stop maintaining
   * the SharePoint list. Rows already imported are matched on
   * (registryListId, registryItemId) and refreshed rather than duplicated.
   *
   * `target` is null when the URL hasn't been (or can't be) resolved.
   */
  async upsertRegistryRow(args: {
    registryListId: string
    row: RegistryRow
    target: ResolvedTargetList | null
    syncStartedAt: Date
  }): Promise<{ id: string; created: boolean }> {
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
      return { id: existing.id, created: false }
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
    return { id: created.id, created: true }
  }

  /**
   * After a per-list sync finishes, write the outcome onto the
   * distribution_lists row so the UI has counters without having to join
   * against resources.
   */
  async markSyncResult(args: {
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

  /** Listed by the API; used by the Sidebar's Layer 1 and the admin portal. */
  // ── Access scoping for the read (sidebar) API ────────────────────
  //
  // These list/item endpoints are reachable by any authenticated user, so the
  // results must be filtered to the caller's job-profile allow-list — exactly
  // like the RAG retrieval path — or they leak the existence, titles, codes,
  // and SharePoint URLs of documents the caller can't access.

  /** The sharepoint codes this viewer's profile is allowed to see. */
  private async allowedCodes(access: ViewerAccess): Promise<string[]> {
    // public-only viewers have no allow-list; distribution items always carry
    // a sharepoint_code (never NULL/public), so they can see none of them.
    if (access.publicOnly) return []
    const rows = await this.prisma.jobProfileAccess.findMany({
      where: { jobTitle: access.viewer.jobTitle, department: access.viewer.department },
      select: { sharepointCode: true },
    })
    return rows.map((r) => r.sharepointCode)
  }

  /**
   * The set of distribution-list ids the viewer may see — a list is visible
   * iff it contains at least one item whose code is in the viewer's allow-list.
   * Empty set means "no access", so list/one/items all fail closed.
   */
  async accessibleListIds(access: ViewerAccess): Promise<Set<string>> {
    const codes = await this.allowedCodes(access)
    if (codes.length === 0) return new Set()
    const rows = await this.prisma.distributionListItem.findMany({
      where: { sharepointCode: { in: codes } },
      select: { distributionListId: true },
      distinct: ['distributionListId'],
    })
    return new Set(rows.map((r) => r.distributionListId))
  }

  private mapListRow(r: DistributionList): {
    id: string
    displayName: string
    note: string | null
    listUrl: string
    enabled: boolean
    siteId: string | null
    targetListId: string | null
    createdByEmail: string | null
    lastSyncedAt: Date | null
    lastSyncStatus: string
    lastSyncError: string | null
    counters: { synced: number; pending: number; failed: number; removed: number }
  } {
    return {
      id: r.id,
      displayName: r.displayName,
      note: r.note,
      listUrl: r.listUrl,
      enabled: r.enabled,
      siteId: r.siteId,
      targetListId: r.targetListId,
      createdByEmail: r.createdByEmail,
      lastSyncedAt: r.lastSyncedAt,
      lastSyncStatus: r.lastSyncStatus,
      lastSyncError: r.lastSyncError,
      counters: {
        synced: r.itemsSynced,
        pending: r.itemsPending,
        failed: r.itemsFailed,
        removed: r.itemsRemoved,
      },
    }
  }

  /** ALL lists, unfiltered. Admin-only (`/api/admin/distribution-lists`). */
  async listAllForApi() {
    // Counters come from the item mirror (the index as it is now), not the
    // row's per-run snapshot: a sync run by an admin whose token can't reach
    // a site writes `error / 0 synced` onto that row, hiding documents that
    // earlier runs (by users with access) did sync and that are still live.
    const [rows, grouped] = await Promise.all([
      this.prisma.distributionList.findMany({
        orderBy: [{ lastSyncStatus: 'asc' }, { displayName: 'asc' }],
      }),
      this.prisma.distributionListItem.groupBy({
        by: ['distributionListId', 'syncStatus'],
        _count: { _all: true },
      }),
    ])

    const live = new Map<string, { synced: number; pending: number; failed: number }>()
    for (const g of grouped) {
      const c = live.get(g.distributionListId) ?? { synced: 0, pending: 0, failed: 0 }
      if (g.syncStatus === 'synced') c.synced += g._count._all
      else if (g.syncStatus === 'pending' || g.syncStatus === 'pending_access') c.pending += g._count._all
      else c.failed += g._count._all
      live.set(g.distributionListId, c)
    }

    return rows.map((r) => {
      const c = live.get(r.id)
      return {
        ...this.mapListRow(r),
        counters: {
          synced: c?.synced ?? 0,
          pending: c?.pending ?? 0,
          failed: c?.failed ?? 0,
          // Items removed from the list are deleted from the mirror, so
          // "removed" only exists as the last run's counter.
          removed: r.itemsRemoved,
        },
      }
    })
  }

  /** Only the lists the viewer's job profile can access. User-facing sidebar. */
  async listAccessibleForApi(access: ViewerAccess) {
    const visible = await this.accessibleListIds(access)
    if (visible.size === 0) return []
    const rows = await this.prisma.distributionList.findMany({
      where: { id: { in: Array.from(visible) } },
      orderBy: [{ lastSyncStatus: 'asc' }, { displayName: 'asc' }],
    })
    return rows.map((r) => this.mapListRow(r))
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
    opts: { take?: number; cursor?: string; access: ViewerAccess },
  ) {
    // Restrict to items the viewer's profile is allowed to see. Even though the
    // caller has already been checked against accessibleListIds, filter here
    // too so a list the viewer can partially see never exposes its other items.
    const codes = await this.allowedCodes(opts.access)
    if (codes.length === 0) return []
    const take = Math.min(Math.max(opts.take ?? 100, 1), 500)
    return this.prisma.distributionListItem.findMany({
      where: { distributionListId, sharepointCode: { in: codes } },
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
