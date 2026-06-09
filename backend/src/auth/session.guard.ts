import {
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { IS_PUBLIC_KEY } from './public.decorator.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionService } from './session.service.js'

/**
 * APP_GUARD — runs on every request. Allows handlers tagged @Public() through
 * (e.g. /api/auth/login). For everything else, loads the session row from the
 * `sid` cookie and attaches it as `req.session` so controllers + the
 * @CurrentUser() decorator can use it.
 *
 * Plain class (no @Injectable) — wired in auth.module.ts via a factory
 * provider, same as the other services, so DI works under tsx/esbuild.
 */
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookies: SessionCookieService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true

    const req = ctx.switchToHttp().getRequest<Request>()
    const id = this.cookies.getSessionId(req)
    if (!id) throw new UnauthorizedException('No session')
    const session = await this.sessions.get(id)
    if (!session) throw new UnauthorizedException('Session expired or unknown')

    // Attach for downstream controllers / @CurrentUser().
    ;(req as Request & { session: typeof session }).session = session
    return true
  }
}
