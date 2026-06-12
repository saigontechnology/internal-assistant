import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { SessionService } from '../auth/session.service.js'
import { SharepointController } from './sharepoint.controller.js'
import { SharepointService } from './sharepoint.service.js'

@Module({
  imports: [AuthModule],
  controllers: [SharepointController],
  providers: [
    {
      provide: SharepointService,
      inject: [SessionService],
      useFactory: (s: SessionService) => new SharepointService(s),
    },
  ],
  exports: [SharepointService],
})
export class SharepointModule {}
