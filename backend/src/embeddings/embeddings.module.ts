import { Module } from '@nestjs/common'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { EmbeddingsService } from './embeddings.service.js'

@Module({
  providers: [
    {
      provide: EmbeddingsService,
      inject: [AppConfig, PrismaService],
      useFactory: (c: AppConfig, p: PrismaService) => new EmbeddingsService(c, p),
    },
  ],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
