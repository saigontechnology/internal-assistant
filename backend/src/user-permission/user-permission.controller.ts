import { Controller, Get, Inject, Req } from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { EffectiveProfileService } from './effective-profile.service.js'
import { UserPermissionService } from './user-permission.service.js'

/**
 * Reduced surface — the only user-facing read is `GET /api/user/me`.
 *
 * The old POST /api/user/sync and GET /api/user/sync/status endpoints are gone
 * (no more first-time setup screen / queue UI). All syncing happens silently
 * in the background, gated by the EffectiveProfileService side effects.
 */
@Controller('user')
export class UserPermissionController {
  constructor(
    @Inject(UserPermissionService) private readonly perms: UserPermissionService,
    @Inject(EffectiveProfileService) private readonly effective: EffectiveProfileService,
  ) {}

  /**
   * Returns the caller's profile state. Resolving the effective profile here
   * also triggers the side effects (cold-start scan / weekly re-evaluation)
   * since the frontend hits this endpoint on every load.
   */
  @Get('me')
  async me(@Req() req: Request) {
    const session = sessionOf(req)
    const email = session.username
    if (!email) return { error: 'session_has_no_email' }

    const eff = await this.effective.resolve(session)
    const row = await this.perms.ensure(email)
    return {
      email,
      jobTitle: row.displayJobTitle || row.jobTitle,
      department: row.displayDepartment || row.department,
      profileIndexed: eff.userProfileIndexed,
      publicOnly: eff.publicOnly,
      lastSync: row.lastSync ? row.lastSync.toISOString() : null,
    }
  }
}

function sessionOf(req: Request): Session {
  return (req as Request & { session: Session }).session
}
