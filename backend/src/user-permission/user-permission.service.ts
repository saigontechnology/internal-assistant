import type { UserPermission } from '@prisma/client'
import { normalizeProfileField } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

export interface ProfileTuple {
  jobTitle: string
  department: string
}

export interface UserProfileInput extends ProfileTuple {
  displayJobTitle: string
  displayDepartment: string
}

/**
 * CRUD for `user_permissions`. The row carries each user's normalized
 * (jobTitle, department) tuple plus their personal resync cadence. Access
 * control itself happens via JobProfile / JobProfileAccess — this service
 * does NOT enumerate accessible documents.
 */
export class UserPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Look up a row by email. Returns null if the user has never signed in. */
  async findByEmail(email: string): Promise<UserPermission | null> {
    return this.prisma.userPermission.findUnique({ where: { email } })
  }

  /** Lazy-create on first request. Used by chat / read paths. */
  async ensure(email: string): Promise<UserPermission> {
    const existing = await this.findByEmail(email)
    if (existing) return existing
    return this.prisma.userPermission.create({ data: { email } })
  }

  /**
   * Upsert the user's profile from a fresh /me call. Normalizes both fields
   * and preserves the original casing on `displayJobTitle` / `displayDepartment`
   * for UI use.
   *
   * This is the single Azure AD write path for (jobTitle, department). When an
   * admin has pinned the profile (`profileOverride`), the normalized join keys
   * are left alone so the override survives login and the weekly resync — the
   * row is returned untouched.
   */
  async upsertProfile(
    email: string,
    rawJobTitle: string | null | undefined,
    rawDepartment: string | null | undefined,
  ): Promise<UserPermission> {
    const existing = await this.findByEmail(email)
    if (existing?.profileOverride) return existing

    const jobTitle = normalizeProfileField(rawJobTitle)
    const department = normalizeProfileField(rawDepartment)
    const displayJobTitle = (rawJobTitle ?? '').trim()
    const displayDepartment = (rawDepartment ?? '').trim()
    return this.prisma.userPermission.upsert({
      where: { email },
      create: { email, jobTitle, department, displayJobTitle, displayDepartment },
      update: { jobTitle, department, displayJobTitle, displayDepartment },
    })
  }

  async markSynced(email: string, error: string | null = null): Promise<void> {
    await this.prisma.userPermission.update({
      where: { email },
      data: { lastSync: new Date(), lastError: error },
    })
  }
}
