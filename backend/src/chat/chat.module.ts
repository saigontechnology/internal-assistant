import { Module } from '@nestjs/common'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsModule } from '../embeddings/embeddings.module.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { ChatHistoryService } from './chat-history.service.js'
import { ChatController } from './chat.controller.js'
import { ChatService } from './chat.service.js'
import { ResearchAgentService } from './research-agent.service.js'

@Module({
  imports: [EmbeddingsModule],
  controllers: [ChatController],
  providers: [
    {
      provide: ResearchAgentService,
      inject: [AppConfig, EmbeddingsService],
      useFactory: (c: AppConfig, e: EmbeddingsService) => new ResearchAgentService(c, e),
    },
    {
      provide: ChatService,
      inject: [AppConfig, EmbeddingsService, ResearchAgentService],
      useFactory: (c: AppConfig, e: EmbeddingsService, r: ResearchAgentService) =>
        new ChatService(c, e, r),
    },
    {
      provide: ChatHistoryService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new ChatHistoryService(p),
    },
  ],
  exports: [ChatService, ResearchAgentService, ChatHistoryService],
})
export class ChatModule {}
