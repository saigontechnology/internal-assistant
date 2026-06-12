import { Global, Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { buildDatabaseUrl } from '../config/database-url.js'
import { PrismaService } from './prisma.service.js'

/**
 * Global so feature modules can inject PrismaService without re-importing.
 * Uses a factory provider (no constructor metadata required) — keeps DI
 * working under esbuild/tsx where `emitDecoratorMetadata` is unreliable.
 *
 * Connection string is composed from POSTGRES_* — there is no DATABASE_URL.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = buildDatabaseUrl({
          POSTGRES_HOST: config.getOrThrow<string>('POSTGRES_HOST'),
          POSTGRES_PORT: config.getOrThrow<string | number>('POSTGRES_PORT'),
          POSTGRES_USER: config.getOrThrow<string>('POSTGRES_USER'),
          POSTGRES_PASSWORD: config.getOrThrow<string>('POSTGRES_PASSWORD'),
          POSTGRES_DB: config.getOrThrow<string>('POSTGRES_DB'),
        })
        return new PrismaService(url)
      },
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
