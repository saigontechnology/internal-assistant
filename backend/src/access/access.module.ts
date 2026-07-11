import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { UserPermissionService } from '../user-permission/user-permission.service.js'
import { ViewerAccessService } from './viewer-access.service.js'

/**
 * Provides ViewerAccessService — the read-only, side-effect-free viewer
 * resolver used by the document/list listing endpoints to filter results by
 * the caller's job profile.
 *
 * Imports AuthModule for UserPermissionService (PrismaService and
 * RuntimeSettingsService come from their @Global modules). Deliberately does
 * NOT depend on UserPermissionModule, so DocumentsModule and
 * SharepointListModule can import this without a dependency cycle.
 */
@Module({
  imports: [AuthModule],
  providers: [
    {
      provide: ViewerAccessService,
      inject: [PrismaService, UserPermissionService, RuntimeSettingsService],
      useFactory: (
        p: PrismaService,
        perms: UserPermissionService,
        cfg: RuntimeSettingsService,
      ) => new ViewerAccessService(p, perms, cfg),
    },
  ],
  exports: [ViewerAccessService],
})
export class AccessModule {}
