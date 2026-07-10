import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsModule } from '../embeddings/embeddings.module.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SharepointModule } from '../sharepoint/sharepoint.module.js'
import { SharepointService } from '../sharepoint/sharepoint.service.js'
import { DocumentsController } from './documents.controller.js'
import { DocumentsService } from './documents.service.js'
import { ParsersService } from './parsers.service.js'

@Module({
  // AuthModule supplies AdminGuard for the upload/delete routes.
  imports: [EmbeddingsModule, SharepointModule, AuthModule],
  controllers: [DocumentsController],
  providers: [
    { provide: ParsersService, useFactory: () => new ParsersService() },
    {
      provide: DocumentsService,
      inject: [AppConfig, ParsersService, EmbeddingsService, SharepointService, PrismaService],
      useFactory: (
        c: AppConfig,
        p: ParsersService,
        e: EmbeddingsService,
        s: SharepointService,
        db: PrismaService,
      ) => new DocumentsService(c, p, e, s, db),
    },
  ],
  exports: [DocumentsService, ParsersService],
})
export class DocumentsModule {}
