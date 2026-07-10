import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsModule } from '../embeddings/embeddings.module.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { UserPermissionModule } from '../user-permission/user-permission.module.js'
import { ActiveStreamRegistry } from './active-stream-registry.js'
import { ChatHistoryService } from './chat-history.service.js'
import { ChatSettingsService } from './chat-settings.service.js'
import { ChatController } from './chat.controller.js'
import { ChatService } from './chat.service.js'
import { ResumableStreamService } from './resumable-stream.service.js'

@Module({
  imports: [AuthModule, EmbeddingsModule, UserPermissionModule],
  controllers: [ChatController],
  providers: [
    {
      provide: ChatSettingsService,
      inject: [PrismaService, AppConfig],
      useFactory: (p: PrismaService, c: AppConfig) => new ChatSettingsService(p, c),
    },
    {
      provide: ChatService,
      inject: [AppConfig, EmbeddingsService, ChatSettingsService],
      useFactory: (c: AppConfig, e: EmbeddingsService, s: ChatSettingsService) =>
        new ChatService(c, e, s),
    },
    {
      provide: ChatHistoryService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new ChatHistoryService(p),
    },
    {
      provide: ResumableStreamService,
      inject: [AppConfig],
      useFactory: (c: AppConfig) => new ResumableStreamService(c),
    },
    // Singleton in-process registry — one per Nest instance. No deps.
    { provide: ActiveStreamRegistry, useFactory: () => new ActiveStreamRegistry() },
  ],
  exports: [ChatService, ChatHistoryService, ChatSettingsService],
})
export class ChatModule {}
