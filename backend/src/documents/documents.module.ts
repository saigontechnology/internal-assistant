import { Module } from '@nestjs/common'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsModule } from '../embeddings/embeddings.module.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { SharepointModule } from '../sharepoint/sharepoint.module.js'
import { SharepointService } from '../sharepoint/sharepoint.service.js'
import { DocumentsController } from './documents.controller.js'
import { DocumentsService } from './documents.service.js'
import { ParsersService } from './parsers.service.js'

@Module({
  imports: [EmbeddingsModule, SharepointModule],
  controllers: [DocumentsController],
  providers: [
    { provide: ParsersService, useFactory: () => new ParsersService() },
    {
      provide: DocumentsService,
      inject: [AppConfig, ParsersService, EmbeddingsService, SharepointService],
      useFactory: (c: AppConfig, p: ParsersService, e: EmbeddingsService, s: SharepointService) =>
        new DocumentsService(c, p, e, s),
    },
  ],
  exports: [DocumentsService, ParsersService],
})
export class DocumentsModule {}
