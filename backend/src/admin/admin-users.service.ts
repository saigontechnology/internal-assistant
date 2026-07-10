import { normalizeProfileField } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

export interface AdminUserRow {
  email: string
  role: string
  isActive: boolean
  /** Original AAD casing, or the admin's raw input when overridden. */
  jobTitle: string
  department: string
  /** The normalized join keys actually used for access filtering. */
  normalizedJobTitle: string
  normalizedDepartment: string
  profileOverride: boolean
  isAllowedToSync: boolean
  lastSync: Date | null
  lastError: string | null
  createdAt: Date
}

/**
 * Backs `/api/admin/users`. Everything here assumes the caller is already
 * known to be an admin (AdminGuard) — no authorization decisions are made in
 * this service, only the self-lockout checks that live in the controller.
 */
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AdminUserRow[]> {
    const [users, allowlist] = await Promise.all([
      this.prisma.userPermission.findMany({ orderBy: { email: 'asc' } }),
      this.prisma.syncAllowlist.findMany({ select: { email: true } }),
    ])
    // sync_allowlist stores lowercased emails; user_permissions keeps whatever
    // casing MSAL handed us. Compare on the lowercased form.
    const allowed = new Set(allowlist.map((a) => a.email.toLocaleLowerCase()))

    return users.map((u) => ({
      email: u.email,
      role: u.role,
      isActive: u.isActive,
      jobTitle: u.displayJobTitle || u.jobTitle,
      department: u.displayDepartment || u.department,
      normalizedJobTitle: u.jobTitle,
      normalizedDepartment: u.department,
      profileOverride: u.profileOverride,
      isAllowedToSync: allowed.has(u.email.toLocaleLowerCase()),
      lastSync: u.lastSync,
      lastError: u.lastError,
      createdAt: u.createdAt,
    }))
  }

  async setRole(email: string, role: 'admin' | 'user'): Promise<void> {
    await this.prisma.userPermission.update({ where: { email }, data: { role } })
  }

  async setActive(email: string, isActive: boolean): Promise<void> {
    await this.prisma.userPermission.update({ where: { email }, data: { isActive } })
    // Deactivating doesn't need to kill live sessions eagerly — SessionGuard
    // rejects and deletes them on the next request — but doing it here closes
    // the window for an in-flight resumable chat stream.
    if (!isActive) {
      await this.prisma.session.deleteMany({ where: { username: email } })
    }
  }

  async setSyncAccess(email: string, allowed: boolean): Promise<void> {
    const key = email.toLocaleLowerCase()
    if (allowed) {
      await this.prisma.syncAllowlist.upsert({
        where: { email: key },
        create: { email: key },
        update: {},
      })
    } else {
      await this.prisma.syncAllowlist.deleteMany({ where: { email: key } })
    }
  }

  /**
   * Pin (jobTitle, department) manually. Sets `profileOverride` so the Azure AD
   * write path stops touching the join keys, and clears `lastSync` so the
   * user's next authenticated request kicks off a scan for the new profile.
   */
  async setProfile(email: string, rawJobTitle: string, rawDepartment: string): Promise<void> {
    await this.prisma.userPermission.update({
      where: { email },
      data: {
        jobTitle: normalizeProfileField(rawJobTitle),
        department: normalizeProfileField(rawDepartment),
        displayJobTitle: rawJobTitle.trim(),
        displayDepartment: rawDepartment.trim(),
        profileOverride: true,
        lastSync: null,
      },
    })
  }

  /** Hand ownership of the profile back to Azure AD on the next login. */
  async clearProfileOverride(email: string): Promise<void> {
    await this.prisma.userPermission.update({
      where: { email },
      data: { profileOverride: false, lastSync: null },
    })
  }

  /**
   * Mark the user's profile stale so it gets re-scanned.
   *
   * The scan itself needs the *user's* delegated Graph token, which we don't
   * hold server-side, so this can't run immediately: it clears `lastSync` on
   * both the user row and their job profile (plus any stuck `syncing` lock),
   * and the scan fires on that user's next authenticated request.
   */
  async forceResync(email: string): Promise<{ scheduled: boolean }> {
    const user = await this.prisma.userPermission.findUnique({ where: { email } })
    if (!user) return { scheduled: false }

    await this.prisma.$transaction([
      this.prisma.userPermission.update({
        where: { email },
        data: { lastSync: null, lastError: null },
      }),
      this.prisma.jobProfile.updateMany({
        where: { jobTitle: user.jobTitle, department: user.department },
        data: { lastSync: null, syncing: false, lastError: null },
      }),
    ])
    return { scheduled: true }
  }
}
