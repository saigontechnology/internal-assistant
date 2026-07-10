import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AdminRoleService } from './admin-role.service.js'
import { AuthService } from './auth.service.js'
import { Public } from './public.decorator.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionService } from './session.service.js'
import { SyncAllowlistService } from './sync-allowlist.service.js'

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionCookieService) private readonly cookies: SessionCookieService,
    @Inject(SyncAllowlistService) private readonly allowlist: SyncAllowlistService,
    @Inject(AdminRoleService) private readonly roles: AdminRoleService,
  ) {}

  @Public()
  @Get('login')
  async login(@Res() res: Response) {
    const url = await this.auth.beginLogin(res)
    res.redirect(url)
  }

  @Public()
  @Get('callback')
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ) {
    const target = await this.auth.completeLogin(req, res, { code, state })
    res.redirect(target)
  }

  /**
   * Public on purpose — the frontend `useAuth()` polls /me on every page load
   * and expects 200 with `{authenticated: false}` rather than a 401 when no
   * session exists. Matches the legacy Hono contract.
   */
  @Public()
  @Get('me')
  async me(@Req() req: Request) {
    const id = this.cookies.getSessionId(req)
    if (!id) return { authenticated: false }
    const session = await this.sessions.get(id)
    if (!session) return { authenticated: false }

    const state = await this.roles.getAccountState(session.username)
    // Deactivated mid-session: report signed-out so the SPA drops to login
    // rather than rendering a shell whose every API call 403s.
    if (state && !state.isActive) return { authenticated: false }

    const isAllowedToSync = await this.allowlist.isAllowed(session.username)
    const role = state?.role ?? 'user'
    return {
      authenticated: true,
      user: {
        username: session.username,
        name: session.name,
        isAllowedToSync,
        role,
        isAdmin: role === 'admin',
      },
    }
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.auth.logout(req, res)
    res.json({ ok: true })
  }
}
