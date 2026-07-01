import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { SessionService } from '../auth/session.service.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsModule } from '../documents/documents.module.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SharepointListModule } from '../sharepoint-list/sharepoint-list.module.js'
import { SharepointListService } from '../sharepoint-list/sharepoint-list.service.js'
import { UserPermissionController } from './user-permission.controller.js'
import { UserPermissionService } from './user-permission.service.js'
import { UserResourcePermissionService } from './user-resource-permission.service.js'
import { UserSyncQueue } from './user-sync.queue.js'
import { UserSyncService } from './user-sync.service.js'

@Module({
  imports: [AuthModule, DocumentsModule, SharepointListModule],
  controllers: [UserPermissionController],
  providers: [
    {
      provide: UserPermissionService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new UserPermissionService(p),
    },
    {
      provide: UserResourcePermissionService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new UserResourcePermissionService(p),
    },
    {
      provide: UserSyncQueue,
      useFactory: () => new UserSyncQueue(),
    },
    {
      provide: UserSyncService,
      inject: [
        AppConfig,
        PrismaService,
        SharepointListService,
        DocumentsService,
        UserPermissionService,
        UserResourcePermissionService,
        UserSyncQueue,
        SessionService,
      ],
      useFactory: (
        c: AppConfig,
        p: PrismaService,
        l: SharepointListService,
        d: DocumentsService,
        up: UserPermissionService,
        ur: UserResourcePermissionService,
        q: UserSyncQueue,
        s: SessionService,
      ) => new UserSyncService(c, p, l, d, up, ur, q, s),
    },
  ],
  exports: [UserPermissionService, UserResourcePermissionService, UserSyncQueue, UserSyncService],
})
export class UserPermissionModule {}
