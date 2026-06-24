import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { GraphMeService } from '../user-permission/graph-me.service.js'
import { UserPermissionService } from '../user-permission/user-permission.service.js'
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
      ],
      useFactory: (
        c: AppConfig,
        m: MsalService,
        s: SessionService,
        k: SessionCookieService,
        g: GraphMeService,
        u: UserPermissionService,
        b: LoginEventBus,
      ) => new AuthService(c, m, s, k, g, u, b),
    },
    {
      provide: SessionGuard,
      inject: [Reflector, SessionCookieService, SessionService],
      useFactory: (r: Reflector, c: SessionCookieService, s: SessionService) =>
        new SessionGuard(r, c, s),
    },
    { provide: APP_GUARD, useExisting: SessionGuard },
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
  ],
})
export class AuthModule {}
