import { Module } from '@nestjs/common'
import { AppConfigModule } from './config/config.module.js'
import { PrismaModule } from './prisma/prisma.module.js'
import { AuthModule } from './auth/auth.module.js'
import { EmbeddingsModule } from './embeddings/embeddings.module.js'
import { SharepointModule } from './sharepoint/sharepoint.module.js'
import { DocumentsModule } from './documents/documents.module.js'
import { ChatModule } from './chat/chat.module.js'
import { SharepointListModule } from './sharepoint-list/sharepoint-list.module.js'
import { AppController } from './app.controller.js'

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    EmbeddingsModule,
    SharepointModule,
    DocumentsModule,
    SharepointListModule,
    ChatModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
