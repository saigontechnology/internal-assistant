import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { AuthService } from './auth.service.js'
import { Public } from './public.decorator.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionService } from './session.service.js'

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionCookieService) private readonly cookies: SessionCookieService,
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
    return {
      authenticated: true,
      user: { username: session.username, name: session.name },
    }
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    await this.auth.logout(req, res)
    res.json({ ok: true })
  }
}
