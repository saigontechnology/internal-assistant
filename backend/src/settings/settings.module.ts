import { Global, Module } from '@nestjs/common'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from './runtime-settings.service.js'

/**
 * Global so any feature module can inject RuntimeSettingsService without
 * re-importing — it shadows AppConfig, which is global for the same reason.
 *
 * Factory provider, no constructor metadata, matching the rest of the app so
 * DI works under tsx/esbuild without `emitDecoratorMetadata`.
 */
@Global()
@Module({
  providers: [
    {
      provide: RuntimeSettingsService,
      inject: [PrismaService, AppConfig],
      useFactory: (p: PrismaService, c: AppConfig) => new RuntimeSettingsService(p, c),
    },
  ],
  exports: [RuntimeSettingsService],
})
export class SettingsModule {}
