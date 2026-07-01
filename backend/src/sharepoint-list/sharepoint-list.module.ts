import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsModule } from '../documents/documents.module.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DistributionListController } from './distribution-list.controller.js'
import { DistributionListService } from './distribution-list.service.js'
import { ListWatcherService } from './list-watcher.service.js'
import { SharepointListService } from './sharepoint-list.service.js'
import { SyncController } from './sync.controller.js'

@Module({
  imports: [AuthModule, DocumentsModule],
  controllers: [SyncController, DistributionListController],
  providers: [
    {
      provide: SharepointListService,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => new SharepointListService(c),
    },
    {
      provide: DistributionListService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new DistributionListService(p),
    },
    {
      provide: ListWatcherService,
      inject: [PrismaService, SharepointListService, DocumentsService, DistributionListService, AppConfig],
      useFactory: (
        p: PrismaService,
        s: SharepointListService,
        d: DocumentsService,
        dl: DistributionListService,
        c: AppConfig,
      ) => new ListWatcherService(p, s, d, dl, c),
    },
  ],
  exports: [SharepointListService, ListWatcherService, DistributionListService],
})
export class SharepointListModule {}
