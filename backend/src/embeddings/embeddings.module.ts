import { Module } from '@nestjs/common'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { EmbeddingsService } from './embeddings.service.js'

@Module({
  providers: [
    {
      provide: EmbeddingsService,
      // RuntimeSettingsService supplies the embedding model, the retrieval
      // knobs, the retry count, and the concurrency cap — all admin-editable,
      // all read per-call rather than captured at construction.
      inject: [AppConfig, PrismaService, RuntimeSettingsService],
      useFactory: (c: AppConfig, p: PrismaService, s: RuntimeSettingsService) =>
        new EmbeddingsService(c, p, s),
    },
  ],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
