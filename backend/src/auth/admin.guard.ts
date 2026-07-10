import { CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AdminRoleService, type AccountState } from './admin-role.service.js'

/**
 * Controller-level guard for the admin surface. Runs *after* the global
 * SessionGuard (APP_GUARD), so `req.session` is already populated and the
 * account has already been checked for deactivation.
 *
 * SessionGuard stashes the account state on the request, so the common path
 * costs no extra query here.
 */
export class AdminGuard implements CanActivate {
  constructor(private readonly roles: AdminRoleService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const session = req.session
    if (!session) throw new ForbiddenException('Admin access required')

    const state = req.accountState ?? (await this.roles.getAccountState(session.username))
    if (state?.role !== 'admin') throw new ForbiddenException('Admin access required')
    return true
  }
}

export type AuthedRequest = Request & {
  session?: Session
  accountState?: AccountState | null
}
