import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

export interface AccountState {
  role: string
  isActive: boolean
}

/**
 * Reads and writes the admin-portal bits of `user_permissions`: the `role`
 * column and the `is_active` flag.
 *
 * Email handling: `user_permissions.email` is keyed on whatever casing MSAL
 * hands us in `account.username`, which the tenant may return mixed-case.
 * Lookups from a session therefore use that exact value (indexed PK hit),
 * while anything sourced from ADMIN_EMAILS — which we normalize to lowercase —
 * matches case-insensitively so we never create a second row for the same
 * human.
 */
export class AdminRoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** Role + activation for a session username. Null when the user has no row yet. */
  async getAccountState(username: string | null | undefined): Promise<AccountState | null> {
    if (!username) return null
    const row = await this.prisma.userPermission.findUnique({
      where: { email: username },
      select: { role: true, isActive: true },
    })
    return row
  }

  async isAdmin(username: string | null | undefined): Promise<boolean> {
    const state = await this.getAccountState(username)
    return state?.role === 'admin'
  }

  /**
   * Promote every ADMIN_EMAILS entry that already has a row. Called once at
   * boot. Deliberately does NOT create rows: a bootstrap row keyed on the
   * lowercased email would collide with the mixed-case row MSAL creates at
   * login, leaving two rows for one user. Users who have never signed in are
   * promoted by `promoteIfBootstrapAdmin` on their first login instead.
   *
   * Returns the number of rows promoted.
   */
  async promoteBootstrapAdmins(): Promise<number> {
    const emails = this.config.adminEmails
    if (emails.length === 0) return 0
    return this.prisma.$executeRaw`
      UPDATE user_permissions
         SET role = 'admin'
       WHERE lower(email) = ANY(${emails}::text[])
         AND role <> 'admin'
    `
  }

  /**
   * Promote this user if they're listed in ADMIN_EMAILS. Called on every login,
   * after the profile row exists. One-way: an admin granted through the portal
   * is never demoted by dropping them from the env var.
   */
  async promoteIfBootstrapAdmin(email: string): Promise<void> {
    if (!this.config.adminEmails.includes(email.toLocaleLowerCase())) return
    await this.prisma.userPermission.updateMany({
      where: { email, role: { not: 'admin' } },
      data: { role: 'admin' },
    })
  }
}
