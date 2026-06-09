import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * Injectable wrapper around PrismaClient.
 *
 * Prisma 7 connects through an adapter rather than the in-schema `url`. The
 * pg adapter is what makes `prisma.$queryRaw` against `halfvec(2048)` work
 * (see EmbeddingsService) — Prisma's data proxy/Accelerate doesn't carry
 * arbitrary type casts through.
 *
 * Instantiated via PrismaModule's factory provider so it doesn't depend on
 * reflected constructor metadata (which is unreliable under esbuild/tsx).
 */
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor(connectionString: string) {
    super({ adapter: new PrismaPg({ connectionString }) })
  }

  async onModuleInit() {
    await this.$connect()
    this.logger.log('Prisma connected.')
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
