/**
 * Day-2 smoke test: bootstrap PrismaModule through a minimal Nest container
 * and run a real query against the live DB. Proves PrismaService + the global
 * module wiring works end-to-end before the rest of the app is built.
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Injectable, Logger, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'

class Smoke {
  private readonly logger = new Logger('Smoke')
  constructor(private prisma: PrismaService) {}
  async run() {
    const [{ count: resources }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM resources
    `
    const [{ count: sessions }] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM sessions
    `
    // Touch the ORM surface, not just $queryRaw, to confirm generated client works.
    const recent = await this.prisma.session.findMany({ take: 1, orderBy: { createdAt: 'desc' } })
    this.logger.log(`resources=${resources}  sessions=${sessions}  sampleSessionFound=${recent.length}`)
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
  providers: [{ provide: Smoke, inject: [PrismaService], useFactory: (p: PrismaService) => new Smoke(p) }],
})
class SmokeModule {}

const app = await NestFactory.createApplicationContext(SmokeModule, { logger: ['error', 'warn', 'log'] })
await app.get(Smoke).run()
await app.close()
