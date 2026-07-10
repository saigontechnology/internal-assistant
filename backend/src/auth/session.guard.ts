import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AdminRoleService } from './admin-role.service.js'
import type { AuthedRequest } from './admin.guard.js'
import { IS_PUBLIC_KEY } from './public.decorator.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionService } from './session.service.js'

/**
 * APP_GUARD — runs on every request. Allows handlers tagged @Public() through
 * (e.g. /api/auth/login). For everything else, loads the session row from the
 * `sid` cookie and attaches it as `req.session` so controllers + the
 * @CurrentUser() decorator can use it.
 *
 * Also enforces deactivation: an admin can flip `user_permissions.is_active`
 * to false and the user's very next request tears down their session. The
 * account state is attached as `req.accountState` so AdminGuard can reuse it.
 *
 * Plain class (no @Injectable) — wired in auth.module.ts via a factory
 * provider, same as the other services, so DI works under tsx/esbuild.
 */
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookies: SessionCookieService,
    private readonly sessions: SessionService,
    private readonly roles: AdminRoleService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (isPublic) return true

    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    const id = this.cookies.getSessionId(req)
    if (!id) throw new UnauthorizedException('No session')
    const session = await this.sessions.get(id)
    if (!session) throw new UnauthorizedException('Session expired or unknown')

    // A missing row means the user has never been profiled — treat as active
    // so first-login requests aren't rejected before AuthService writes it.
    const state = await this.roles.getAccountState(session.username)
    if (state && !state.isActive) {
      await this.sessions.delete(id).catch(() => {})
      throw new ForbiddenException('Account deactivated')
    }

    // Attach for downstream controllers / @CurrentUser() / AdminGuard.
    req.session = session
    req.accountState = state
    return true
  }
}
