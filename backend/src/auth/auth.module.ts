import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { RateLimitGuard } from '../common/rate-limit.guard.js'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { GraphMeService } from '../user-permission/graph-me.service.js'
import { UserPermissionService } from '../user-permission/user-permission.service.js'
import { AdminRoleService } from './admin-role.service.js'
import { AdminGuard } from './admin.guard.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { LoginEventBus } from './login-event-bus.js'
import { MsalService } from './msal.service.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionGuard } from './session.guard.js'
import { SessionService } from './session.service.js'
import { SyncAllowlistService } from './sync-allowlist.service.js'

/**
 * Wires the auth surface. All services are factory-provided (no constructor
 * metadata) so DI works under tsx/esbuild. Guards still use constructor DI
 * because Nest reads guard metadata internally — that path does work; only
 * user-provided factories trip on missing metadata.
 *
 * UserPermissionService + GraphMeService live here (rather than in
 * UserPermissionModule) so AuthService can call them post-login without a
 * circular module dependency. UserPermissionModule re-exports them for use by
 * the rest of the app.
 */
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: MsalService,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new MsalService(config),
    },
    {
      provide: SessionCookieService,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => new SessionCookieService(config),
    },
    {
      provide: SessionService,
      inject: [PrismaService, MsalService],
      useFactory: (prisma: PrismaService, msal: MsalService) => new SessionService(prisma, msal),
    },
    {
      provide: UserPermissionService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new UserPermissionService(p),
    },
    {
      provide: GraphMeService,
      inject: [SessionService],
      useFactory: (s: SessionService) => new GraphMeService(s),
    },
    {
      provide: LoginEventBus,
      useFactory: () => new LoginEventBus(),
    },
    {
      provide: AuthService,
      inject: [
        AppConfig,
        MsalService,
        SessionService,
        SessionCookieService,
        GraphMeService,
        UserPermissionService,
        LoginEventBus,
        AdminRoleService,
      ],
      useFactory: (
        c: AppConfig,
        m: MsalService,
        s: SessionService,
        k: SessionCookieService,
        g: GraphMeService,
        u: UserPermissionService,
        b: LoginEventBus,
        a: AdminRoleService,
      ) => new AuthService(c, m, s, k, g, u, b, a),
    },
    {
      provide: AdminRoleService,
      inject: [PrismaService, AppConfig],
      useFactory: (p: PrismaService, c: AppConfig) => new AdminRoleService(p, c),
    },
    {
      provide: RateLimitGuard,
      inject: [RuntimeSettingsService],
      useFactory: (s: RuntimeSettingsService) => new RateLimitGuard(s),
    },
    // Registered ahead of SessionGuard, and order matters: global guards run in
    // the order they appear here, and a request we're about to reject shouldn't
    // first pay for a session lookup and an account-state read. Shedding load
    // after doing the work would defeat the point.
    { provide: APP_GUARD, useExisting: RateLimitGuard },
    {
      provide: SessionGuard,
      inject: [Reflector, SessionCookieService, SessionService, AdminRoleService],
      useFactory: (
        r: Reflector,
        c: SessionCookieService,
        s: SessionService,
        a: AdminRoleService,
      ) => new SessionGuard(r, c, s, a),
    },
    { provide: APP_GUARD, useExisting: SessionGuard },
    {
      provide: AdminGuard,
      inject: [AdminRoleService],
      useFactory: (a: AdminRoleService) => new AdminGuard(a),
    },
    {
      provide: SyncAllowlistService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new SyncAllowlistService(p),
    },
  ],
  exports: [
    SessionService,
    SessionCookieService,
    MsalService,
    SyncAllowlistService,
    UserPermissionService,
    GraphMeService,
    LoginEventBus,
    AdminRoleService,
    AdminGuard,
  ],
})
export class AuthModule {}
