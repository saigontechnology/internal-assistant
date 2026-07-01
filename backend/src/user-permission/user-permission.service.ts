import type { UserPermission } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * CRUD for `user_permissions` + the denormalized `listUnauthorized` cache.
 *
 * The chat hot-path reads exactly one row from this service per turn, so the
 * unauthorized-codes set must be available without a join. UserSyncService
 * rebuilds the column at the end of every sync from
 * UserResourcePermissionService (the source of truth).
 *
 * Privacy: this service never returns the full `listUnauthorized` array to
 * callers outside the chat/research path — public endpoints expose
 * `unauthorizedCount` only.
 */
export class UserPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<UserPermission | null> {
    return this.prisma.userPermission.findUnique({ where: { email } })
  }

  /** Create the row if missing. Returns the row regardless. */
  async ensure(email: string): Promise<UserPermission> {
    const existing = await this.findByEmail(email)
    if (existing) return existing
    return this.prisma.userPermission.create({
      data: { email, firstSyncing: true, listUnauthorized: '' },
    })
  }

  /** Parse the comma-joined column into a Set for fast membership checks. */
  parseUnauthorized(row: Pick<UserPermission, 'listUnauthorized'>): Set<string> {
    if (!row.listUnauthorized) return new Set()
    return new Set(
      row.listUnauthorized
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
  }

  /** Load the unauthorized codes for a user. Returns an empty set if no row. */
  async loadUnauthorized(email: string): Promise<Set<string>> {
    const row = await this.findByEmail(email)
    if (!row) return new Set()
    return this.parseUnauthorized(row)
  }

  async markRunning(email: string, itemsTotal: number | null = null): Promise<void> {
    await this.prisma.userPermission.update({
      where: { email },
      data: {
        syncingStartedAt: new Date(),
        itemsSeen: 0,
        itemsTotal,
        lastError: null,
      },
    })
  }

  async updateProgress(email: string, itemsSeen: number, itemsTotal: number | null): Promise<void> {
    await this.prisma.userPermission.update({
      where: { email },
      data: { itemsSeen, itemsTotal },
    })
  }

  async markFinished(
    email: string,
    unauthorizedCodes: string[],
    error: string | null = null,
  ): Promise<void> {
    const unique = Array.from(new Set(unauthorizedCodes.map((c) => c.trim()).filter(Boolean))).sort()
    await this.prisma.userPermission.update({
      where: { email },
      data: {
        firstSyncing: false,
        listUnauthorized: unique.join(','),
        lastSync: new Date(),
        syncingStartedAt: null,
        lastError: error,
      },
    })
  }

  /** Best-effort heal: clear `syncingStartedAt` if it's older than maxMs. */
  async healStale(email: string, maxMs: number): Promise<boolean> {
    const row = await this.findByEmail(email)
    if (!row || !row.syncingStartedAt) return false
    if (Date.now() - row.syncingStartedAt.getTime() < maxMs) return false
    await this.prisma.userPermission.update({
      where: { email },
      data: { syncingStartedAt: null },
    })
    return true
  }
}
