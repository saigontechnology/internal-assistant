import type { JobProfile } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import type { ProfileTuple } from './user-permission.service.js'

/**
 * CRUD for `job_profiles` + `job_profile_access`. The (jobTitle, department)
 * tuple is always assumed pre-normalized by callers; this service does no
 * trimming/lowercasing itself.
 */
export class JobProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async find(profile: ProfileTuple): Promise<JobProfile | null> {
    return this.prisma.jobProfile.findUnique({
      where: { jobTitle_department: { jobTitle: profile.jobTitle, department: profile.department } },
    })
  }

  /** Lazy-create the row in 'never scanned' state. */
  async ensure(profile: ProfileTuple): Promise<JobProfile> {
    const existing = await this.find(profile)
    if (existing) return existing
    return this.prisma.jobProfile.create({
      data: { jobTitle: profile.jobTitle, department: profile.department },
    })
  }

  /** Atomic `claim or report busy` — single statement to avoid race. */
  async tryAcquireLock(profile: ProfileTuple): Promise<boolean> {
    const res = await this.prisma.jobProfile.updateMany({
      where: {
        jobTitle: profile.jobTitle,
        department: profile.department,
        syncing: false,
      },
      data: { syncing: true },
    })
    return res.count === 1
  }

  async releaseLock(
    profile: ProfileTuple,
    args: { success: boolean; email: string; error?: string | null },
  ): Promise<void> {
    await this.prisma.jobProfile.update({
      where: { jobTitle_department: { jobTitle: profile.jobTitle, department: profile.department } },
      data: {
        syncing: false,
        lastSync: args.success ? new Date() : undefined,
        syncedByEmail: args.success ? args.email : undefined,
        lastError: args.error ?? null,
      },
    })
  }

  /**
   * Insert a batch of allow-list rows in one statement, ignoring duplicates.
   * Called from inside the scan loop with a small buffer (default 10 codes)
   * so newly-resolved codes become visible to the chat filter in near
   * real-time without paying for a DB roundtrip on every single row.
   */
  async addAllowedCodes(profile: ProfileTuple, sharepointCodes: string[]): Promise<void> {
    const unique = Array.from(new Set(sharepointCodes.filter(Boolean)))
    if (unique.length === 0) return
    await this.prisma.jobProfileAccess.createMany({
      data: unique.map((sharepointCode) => ({
        jobTitle: profile.jobTitle,
        department: profile.department,
        sharepointCode,
      })),
      skipDuplicates: true,
    })
  }

  /**
   * Drop allow-list rows for this profile whose code isn't in `seenCodes`.
   * Run at the end of a successful scan to clean up codes the user has lost
   * access to since the previous scan.
   */
  async pruneStaleAccess(profile: ProfileTuple, seenCodes: Set<string>): Promise<void> {
    const existing = await this.prisma.jobProfileAccess.findMany({
      where: { jobTitle: profile.jobTitle, department: profile.department },
      select: { sharepointCode: true },
    })
    const stale = existing
      .map((r) => r.sharepointCode)
      .filter((c) => !seenCodes.has(c))
    if (stale.length === 0) return
    await this.prisma.jobProfileAccess.deleteMany({
      where: {
        jobTitle: profile.jobTitle,
        department: profile.department,
        sharepointCode: { in: stale },
      },
    })
  }

  /** Sharepoint-code allow-list for a profile. Returns empty when no rows. */
  async listAllowedCodes(profile: ProfileTuple): Promise<string[]> {
    const rows = await this.prisma.jobProfileAccess.findMany({
      where: { jobTitle: profile.jobTitle, department: profile.department },
      select: { sharepointCode: true },
    })
    return rows.map((r) => r.sharepointCode)
  }
}
