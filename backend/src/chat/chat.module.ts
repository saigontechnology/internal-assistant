import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsModule } from '../embeddings/embeddings.module.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { UserPermissionModule } from '../user-permission/user-permission.module.js'
import { ChatHistoryService } from './chat-history.service.js'
import { ChatController } from './chat.controller.js'
import { ChatService } from './chat.service.js'

@Module({
  imports: [AuthModule, EmbeddingsModule, UserPermissionModule],
  controllers: [ChatController],
  providers: [
    {
      provide: ChatService,
      inject: [AppConfig, EmbeddingsService],
      useFactory: (c: AppConfig, e: EmbeddingsService) => new ChatService(c, e),
    },
    {
      provide: ChatHistoryService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new ChatHistoryService(p),
    },
  ],
  exports: [ChatService, ChatHistoryService],
})
export class ChatModule {}
