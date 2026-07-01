import { PrismaService } from '../prisma/prisma.service.js'

/**
 * Lookup against the `sync_allowlist` table. Membership is what gates the
 * Sync button in the UI and the POST /sync endpoint on the server.
 * Username comparisons are case-insensitive — MSAL hands us the UPN which
 * is sometimes mixed-case depending on how the tenant is configured.
 */
export class SyncAllowlistService {
  constructor(private readonly prisma: PrismaService) {}

  async isAllowed(username: string | null | undefined): Promise<boolean> {
    if (!username) return false
    const row = await this.prisma.syncAllowlist.findUnique({
      where: { email: username.toLowerCase() },
      select: { email: true },
    })
    return row !== null
  }
}
