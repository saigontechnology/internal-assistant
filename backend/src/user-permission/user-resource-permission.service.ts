import { PrismaService } from '../prisma/prisma.service.js'

export interface CachedPermission {
  authorized: boolean
  checkedAt: Date
}

/**
 * Per-user (sharepointCode → authorized?) cache. Lets the weekly resync skip
 * Graph round-trips for rows already checked within the TTL window.
 *
 * Source of truth for the user's permission view — UserPermissionService's
 * `listUnauthorized` column is a denormalized rebuild from this table at the
 * end of every sync.
 */
export class UserResourcePermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async getMap(email: string): Promise<Map<string, CachedPermission>> {
    const rows = await this.prisma.userResourcePermission.findMany({
      where: { email },
      select: { sharepointCode: true, authorized: true, checkedAt: true },
    })
    return new Map(
      rows.map((r) => [r.sharepointCode, { authorized: r.authorized, checkedAt: r.checkedAt }]),
    )
  }

  async upsert(email: string, code: string, authorized: boolean): Promise<void> {
    await this.prisma.userResourcePermission.upsert({
      where: { email_sharepointCode: { email, sharepointCode: code } },
      create: { email, sharepointCode: code, authorized, checkedAt: new Date() },
      update: { authorized, checkedAt: new Date() },
    })
  }

  /** All codes the user is NOT authorized to read. */
  async listUnauthorizedCodes(email: string): Promise<string[]> {
    const rows = await this.prisma.userResourcePermission.findMany({
      where: { email, authorized: false },
      select: { sharepointCode: true },
    })
    return rows.map((r) => r.sharepointCode)
  }

  /** Remove rows for codes that no longer exist in the live list. */
  async removeStaleCodes(email: string, liveCodes: Set<string>): Promise<void> {
    const existing = await this.prisma.userResourcePermission.findMany({
      where: { email },
      select: { sharepointCode: true },
    })
    const stale = existing
      .map((r) => r.sharepointCode)
      .filter((c) => !liveCodes.has(c))
    if (stale.length === 0) return
    await this.prisma.userResourcePermission.deleteMany({
      where: { email, sharepointCode: { in: stale } },
    })
  }
}
