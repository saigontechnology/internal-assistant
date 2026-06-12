import { Global, Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config'
import { AppConfig } from './app-config.service.js'
import { validateEnv } from './env.schema.js'

/**
 * Global Nest module wrapping @nestjs/config with our zod-validated env.
 *
 * Use `inject: [AppConfig]` in your own providers — never inject the raw
 * ConfigService directly, so renames stay caught at compile time.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
  ],
  providers: [
    {
      provide: AppConfig,
      inject: [ConfigService],
      useFactory: (raw: ConfigService) => new AppConfig(raw as any),
    },
  ],
  exports: [AppConfig],
})
export class AppConfigModule {}
