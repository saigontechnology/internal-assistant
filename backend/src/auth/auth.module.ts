import { Module } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { AuthController } from './auth.controller.js'
import { AuthService } from './auth.service.js'
import { MsalService } from './msal.service.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionGuard } from './session.guard.js'
import { SessionService } from './session.service.js'

/**
 * Wires the auth surface. All services are factory-provided (no constructor
 * metadata) so DI works under tsx/esbuild. Guards still use constructor DI
 * because Nest reads guard metadata internally — that path does work; only
 * user-provided factories trip on missing metadata.
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
      provide: AuthService,
      inject: [AppConfig, MsalService, SessionService, SessionCookieService],
      useFactory: (c: AppConfig, m: MsalService, s: SessionService, k: SessionCookieService) =>
        new AuthService(c, m, s, k),
    },
    {
      provide: SessionGuard,
      inject: [Reflector, SessionCookieService, SessionService],
      useFactory: (r: Reflector, c: SessionCookieService, s: SessionService) =>
        new SessionGuard(r, c, s),
    },
    { provide: APP_GUARD, useExisting: SessionGuard },
  ],
  exports: [SessionService, SessionCookieService, MsalService],
})
export class AuthModule {}
