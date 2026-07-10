import { Module } from '@nestjs/common'
import { AdminRoleService } from '../auth/admin-role.service.js'
import { AuthModule } from '../auth/auth.module.js'
import { ChatModule } from '../chat/chat.module.js'
import { AppConfig } from '../config/app-config.service.js'
import { DocumentsModule } from '../documents/documents.module.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SharepointListModule } from '../sharepoint-list/sharepoint-list.module.js'
import { AdminBootstrapService } from './admin-bootstrap.service.js'
import { AdminChatModelController } from './admin-chat-model.controller.js'
import { AdminDocumentsController } from './admin-documents.controller.js'
import { AdminListsController } from './admin-lists.controller.js'
import { AdminSettingsController } from './admin-settings.controller.js'
import { AdminUsersController } from './admin-users.controller.js'
import { AdminUsersService } from './admin-users.service.js'

/**
 * The `/api/admin/*` surface. Every controller here is behind AdminGuard
 * (imported from AuthModule), which runs after the global SessionGuard.
 *
 * Factory providers throughout — no constructor metadata — matching the rest
 * of the app so DI works under tsx/esbuild.
 */
@Module({
  imports: [AuthModule, ChatModule, DocumentsModule, SharepointListModule],
  controllers: [
    AdminUsersController,
    AdminDocumentsController,
    AdminListsController,
    AdminChatModelController,
    AdminSettingsController,
  ],
  providers: [
    {
      provide: AdminUsersService,
      inject: [PrismaService],
      useFactory: (p: PrismaService) => new AdminUsersService(p),
    },
    {
      provide: AdminBootstrapService,
      inject: [AdminRoleService, AppConfig],
      useFactory: (r: AdminRoleService, c: AppConfig) => new AdminBootstrapService(r, c),
    },
  ],
})
export class AdminModule {}
