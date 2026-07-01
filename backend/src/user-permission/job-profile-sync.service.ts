import type { Session } from '@prisma/client'
import { SessionService } from '../auth/session.service.js'
import { AppConfig } from '../config/app-config.service.js'
import {
  DocumentsService,
  type SharepointUpsertOutcome,
} from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DistributionListService } from '../sharepoint-list/distribution-list.service.js'
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
 * Walks every distribution_lists row currently in the DB (populated by the
 * watcher). For each list the user can read, it:
 *   1. backfills resources with files this user can resolve;
 *   2. records sharepointCode → job_profile_access edges;
 *   3. mirrors per-code state into distribution_list_items;
 *   4. records a job_profile_distribution_lists edge for the list itself.
 *
 * Lists the user can't read get no negative edge — absence == no access.
 * See docs/role-based-access-plan.md and docs/multi-list-watcher-plan.md §6.2.
 */
const ACCESS_FLUSH_BATCH_SIZE = 10

export class JobProfileSyncService {
  constructor(
    private readonly config: AppConfig,
    private readonly listSvc: SharepointListService,
    private readonly documents: DocumentsService,
    private readonly prisma: PrismaService,
    private readonly perms: UserPermissionService,
    private readonly profiles: JobProfileService,
    private readonly queue: JobProfileSyncQueue,
    private readonly sessions: SessionService,
    private readonly distributionLists: DistributionListService,
  ) {}

  async evaluateAndMaybeEnqueue(session: Session, profile: ProfileTuple): Promise<void> {
    const email = session.username
    if (!email) return
    const user = await this.perms.findByEmail(email)
    if (!user) return
    if (!isStale(user.lastSync, this.config.userSyncIntervalDays)) return

    const row = await this.profiles.ensure(profile)
    const profileStale = isStale(row.lastSync, this.config.userSyncIntervalDays)
    if (!profileStale || row.syncing) {
      await this.perms.markSynced(email)
      return
    }

    const acquired = await this.profiles.tryAcquireLock(profile)
    if (!acquired) {
      await this.perms.markSynced(email)
      return
    }

    this.queue.enqueue(profile, () => this.run(profile, session))
  }

  async kickoffNewProfile(session: Session, profile: ProfileTuple): Promise<void> {
    await this.profiles.ensure(profile)
    const acquired = await this.profiles.tryAcquireLock(profile)
    if (!acquired) return
    this.queue.enqueue(profile, () => this.run(profile, session))
  }

  private async run(profile: ProfileTuple, session: Session): Promise<void> {
    const email = session.username ?? '<unknown>'
    const tokens = new DelegatedGraphTokenProvider(session, this.sessions)
    const seenCodes = new Set<string>()
    const pendingBatch: string[] = []
    const flushPending = async () => {
      if (pendingBatch.length === 0) return
      await this.profiles.addAllowedCodes(profile, pendingBatch)
      pendingBatch.length = 0
    }
    let fatalError: string | null = null
    const scanStartedAt = new Date()

    try {
      // Bootstrap path: walk the registry with THIS user's token, upserting
      // distribution_lists rows as we go. This makes the per-profile scan
      // self-sufficient — on first login (empty DB) the scan still runs end
      // to end without needing a separate watcher sync first. On subsequent
      // runs it just refreshes lastSeenAt for rows the watcher already
      // discovered.
      const registry = await this.listSvc.resolveRegistry(tokens)
      console.log(
        `[job-profile-sync ${profile.jobTitle}/${profile.department}] registry rows visible to this user: ${registry.rows.length}`,
      )

      const dlRows: { id: string; displayName: string; siteId: string; targetListId: string }[] = []
      for (const row of registry.rows) {
        const target = await this.listSvc.resolveTargetList(tokens, row.listUrl)
        const upserted = await this.distributionLists.upsertRegistryRow({
          registryListId: registry.registryListId,
          row,
          target,
          syncStartedAt: scanStartedAt,
        })
        if (target) {
          dlRows.push({
            id: upserted.id,
            displayName: row.displayName,
            siteId: target.siteId,
            targetListId: target.listId,
          })
        }
      }

      const liveTargetIds = new Set<string>()
      for (const dl of dlRows) {
        const listId = dl.targetListId
        liveTargetIds.add(listId)
        let canReadThisList = false
        const liveCodes = new Set<string>()
        const seenAt = new Date()
        const counters = {
          seen: 0, ingested: 0, updated: 0, skipped: 0,
          pending: 0, failed: 0, removed: 0,
        }
        let fatalListError: string | null = null

        try {
          await this.prisma.watcherState.upsert({
            where: { listId },
            update: { lastStatus: 'running' },
            create: { listId, lastStatus: 'running' },
          })

          // Warm-path skip: pre-fetch existing resources keyed by code so we
          // can avoid re-downloading rows that haven't changed.
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

          // Incremental sync window — mirror the watcher path.
          const windowDays = this.config.sharepointRegistryIncrementalWindowDays
          const incremental = windowDays > 0
            ? await this.computeIncrementalSince(dl.id, windowDays)
            : undefined

          for await (const row of this.listSvc.iterateItemsAt(tokens, dl.siteId, listId, {
            modifiedSince: incremental,
          })) {
            canReadThisList = true
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

            if (!code || !linkUrl) {
              counters.failed++
              continue
            }
            liveCodes.add(code)

            const prior = existingByCode.get(code)
            if (prior && prior.status === 'synced' && prior.version === version) {
              counters.skipped++
              skippedCodes.push(code)
              await this.distributionLists.upsertItem({
                distributionListId: dl.id,
                resourceId: prior.id,
                code, title, version,
                syncStatus: 'synced', syncError: null, seenAt,
              })
              pendingBatch.push(code)
              seenCodes.add(code)
              if (pendingBatch.length >= ACCESS_FLUSH_BATCH_SIZE) await flushPending()
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
              let resolvedAndDownloaded = false
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
                  resolvedAndDownloaded = true
                }
              }
              this.applyOutcome(counters, outcome)

              const after = await this.prisma.resource.findUnique({
                where: { sp_code_uk: { sharepointListId: listId, sharepointCode: code } },
                select: { id: true, syncStatus: true, syncError: true },
              })
              await this.distributionLists.upsertItem({
                distributionListId: dl.id,
                resourceId: after?.id ?? null,
                code, title, version,
                syncStatus: after?.syncStatus ?? (title ? 'pending_access' : 'failed_resolve'),
                syncError: after?.syncError ?? (title ? null : 'list row has no Title'),
                seenAt,
              })

              if (resolvedAndDownloaded || after?.syncStatus === 'synced') {
                pendingBatch.push(code)
                seenCodes.add(code)
                if (pendingBatch.length >= ACCESS_FLUSH_BATCH_SIZE) {
                  await flushPending()
                }
              }
            } catch (err) {
              counters.failed++
              console.warn(
                `[job-profile-sync ${profile.jobTitle}/${profile.department}] row failed for code=${code}:`,
                (err as Error).message?.slice(0, 200),
              )
              await this.documents.upsertFromSharepointList({
                listId, code, version, title, sourceMetadata,
                status: 'failed_resolve', error: (err as Error).message.slice(0, 500),
              }).catch(() => {})
              await this.distributionLists.upsertItem({
                distributionListId: dl.id,
                resourceId: null, code, title, version,
                syncStatus: 'failed_resolve',
                syncError: (err as Error).message.slice(0, 500),
                seenAt,
              }).catch(() => {})
            }
          }

          if (skippedCodes.length > 0) {
            await this.prisma.resource.updateMany({
              where: { sharepointListId: listId, sharepointCode: { in: skippedCodes } },
              data: { lastSyncAttempt: seenAt, sharepointPendingVersion: null },
            })
          }

          if (canReadThisList) {
            counters.removed = await this.documents.removeStaleSharepointRows(listId, liveCodes)
            await this.distributionLists.removeOrphanItems(dl.id, liveCodes)
          }
        } catch (err) {
          // 403/404 on the list itself — the profile simply doesn't have
          // access. Skip without recording an edge.
          const msg = (err as Error).message?.slice(0, 200) ?? ''
          if (!/40[134]|forbidden|unauthor/i.test(msg)) {
            fatalListError = (err as Error).message.slice(0, 500)
            console.warn(
              `[job-profile-sync ${profile.jobTitle}/${profile.department}] list ${dl.displayName} iterate failed:`,
              msg,
            )
          }
        }

        // Persist per-list bookkeeping even when access was denied — keeps the
        // UI from showing stale "still running" state.
        const status: 'ok' | 'partial' | 'error' =
          fatalListError ? 'error'
            : (counters.failed > 0 || counters.pending > 0) ? 'partial'
            : 'ok'

        if (canReadThisList || fatalListError) {
          try {
            await this.prisma.watcherState.upsert({
              where: { listId },
              create: {
                listId,
                lastRunAt: new Date(),
                lastStatus: status,
                lastError: fatalListError,
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
                lastError: fatalListError,
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

          try {
            await this.distributionLists.markRegistryRowSyncResult({
              distributionListId: dl.id,
              status,
              counters: {
                synced: counters.ingested + counters.updated + counters.skipped,
                pending: counters.pending,
                failed: counters.failed,
                removed: counters.removed,
              },
              fatalError: fatalListError ?? undefined,
            })
          } catch { /* swallow */ }
        }

        if (canReadThisList) {
          await this.distributionLists.upsertProfileEdge({
            jobTitle: profile.jobTitle,
            department: profile.department,
            distributionListId: dl.id,
          })
        }
      }

      await flushPending()
      await this.profiles.pruneStaleAccess(profile, seenCodes)
      await this.distributionLists.pruneStaleProfileEdges({
        jobTitle: profile.jobTitle,
        department: profile.department,
        syncStartedAt: scanStartedAt,
      })

      // Run-end orphan reconcile — parity with ListWatcherService.sync.
      // Registry rows that disappeared since last run drop to 'removed', and
      // any synced resource whose listId isn't in this run's target set drops
      // to pending_access.
      await this.distributionLists.demoteOrphanRegistryRows(scanStartedAt)
      await this.documents.demoteOrphanedSharepointRows(liveTargetIds)
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
      if (session.username) {
        await this.perms.markSynced(session.username, fatalError).catch(() => {})
      }
    }
  }

  private applyOutcome(
    counters: { ingested: number; updated: number; skipped: number; pending: number; failed: number },
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

  private async computeIncrementalSince(
    distributionListId: string,
    windowDays: number,
  ): Promise<Date | undefined> {
    const row = await this.prisma.distributionList.findUnique({
      where: { id: distributionListId },
      select: { lastSyncedAt: true },
    })
    if (!row?.lastSyncedAt) return undefined
    return new Date(row.lastSyncedAt.getTime() - windowDays * 24 * 60 * 60 * 1000)
  }
}

function trim(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isStale(lastSync: Date | null, intervalDays: number): boolean {
  if (!lastSync) return true
  return Date.now() - lastSync.getTime() >= intervalDays * 24 * 60 * 60 * 1000
}
