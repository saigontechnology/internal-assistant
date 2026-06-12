import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsModule } from '../documents/documents.module.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { ListWatcherService } from './list-watcher.service.js'
import { SharepointListService } from './sharepoint-list.service.js'
import { SyncController } from './sync.controller.js'

@Module({
  imports: [AuthModule, DocumentsModule],
  controllers: [SyncController],
  providers: [
    {
      provide: SharepointListService,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => new SharepointListService(c),
    },
    {
      provide: ListWatcherService,
      inject: [PrismaService, SharepointListService, DocumentsService],
      useFactory: (p: PrismaService, s: SharepointListService, d: DocumentsService) =>
        new ListWatcherService(p, s, d),
    },
  ],
  exports: [SharepointListService, ListWatcherService],
})
export class SharepointListModule {}
