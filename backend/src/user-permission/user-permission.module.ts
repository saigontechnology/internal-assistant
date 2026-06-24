import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { LoginEventBus } from '../auth/login-event-bus.js'
import { SessionService } from '../auth/session.service.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsModule } from '../documents/documents.module.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SharepointListModule } from '../sharepoint-list/sharepoint-list.module.js'
import { SharepointListService } from '../sharepoint-list/sharepoint-list.service.js'
import { EffectiveProfileService } from './effective-profile.service.js'
import { JobProfileSyncQueue } from './job-profile-sync.queue.js'
import { JobProfileSyncService } from './job-profile-sync.service.js'
import { JobProfileService } from './job-profile.service.js'
import { LoginBridge } from './login-bridge.js'
import { UserPermissionController } from './user-permission.controller.js'
import { UserPermissionService } from './user-permission.service.js'

/**
 * UserPermissionService + GraphMeService are defined in AuthModule (to break a
 * circular import with AuthService); we re-export them from AuthModule's
 * exports so consumers can import either module interchangeably.
 */
@Module({
  imports: [AuthModule, DocumentsModule, SharepointListModule],
  controllers: [UserPermissionController],
  providers: [
    {
      provide: JobProfileService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new JobProfileService(p),
    },
    {
      provide: JobProfileSyncQueue,
      useFactory: () => new JobProfileSyncQueue(),
    },
    {
      provide: JobProfileSyncService,
      inject: [
        AppConfig,
        SharepointListService,
        DocumentsService,
        UserPermissionService,
        JobProfileService,
        JobProfileSyncQueue,
        SessionService,
      ],
      useFactory: (
        c: AppConfig,
        l: SharepointListService,
        d: DocumentsService,
        up: UserPermissionService,
        jp: JobProfileService,
        q: JobProfileSyncQueue,
        s: SessionService,
      ) => new JobProfileSyncService(c, l, d, up, jp, q, s),
    },
    {
      provide: EffectiveProfileService,
      inject: [AppConfig, UserPermissionService, JobProfileService, JobProfileSyncService],
      useFactory: (
        c: AppConfig,
        up: UserPermissionService,
        jp: JobProfileService,
        s: JobProfileSyncService,
      ) => new EffectiveProfileService(c, up, jp, s),
    },
    {
      provide: LoginBridge,
      inject: [LoginEventBus, EffectiveProfileService],
      useFactory: (bus: LoginEventBus, eff: EffectiveProfileService) =>
        new LoginBridge(bus, eff),
    },
  ],
  exports: [
    JobProfileService,
    JobProfileSyncService,
    EffectiveProfileService,
  ],
})
export class UserPermissionModule {}
