import type { OnModuleInit } from '@nestjs/common'
import { AdminRoleService } from '../auth/admin-role.service.js'
import { AppConfig } from '../config/app-config.service.js'

/**
 * Promotes every ADMIN_EMAILS entry to role='admin' at boot.
 *
 * Only touches rows that already exist — see AdminRoleService.promoteBootstrapAdmins
 * for why we can't create them here. A bootstrap admin who has never signed in
 * is promoted by AuthService on their first login instead.
 */
export class AdminBootstrapService implements OnModuleInit {
  constructor(
    private readonly roles: AdminRoleService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const emails = this.config.adminEmails
    if (emails.length === 0) {
      console.warn(
        '[admin] ADMIN_EMAILS is empty — no bootstrap admin. Grant the first ' +
          'admin by setting user_permissions.role = \'admin\' directly.',
      )
      return
    }
    try {
      const promoted = await this.roles.promoteBootstrapAdmins()
      console.log(
        `[admin] bootstrap admins: ${emails.join(', ')} (${promoted} promoted this boot)`,
      )
    } catch (err) {
      console.error('[admin] bootstrap promotion failed:', (err as Error).message)
    }
  }
}
