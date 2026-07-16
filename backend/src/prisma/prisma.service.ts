import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

export interface PoolTuning {
  /** Max pooled connections. `pg-pool` defaults to 10 — far too low here. */
  max: number
  idleTimeoutMs: number
  connectionTimeoutMs: number
  /** Server-side `statement_timeout`. 0 disables. */
  statementTimeoutMs: number
  /** pgvector HNSW candidate-list size. */
  efSearch: number
}

/**
 * Postgres startup options, applied to every connection the pool opens.
 *
 * These have to ride on the connection rather than be issued per query.
 * `SET LOCAL hnsw.ef_search` only survives inside a transaction, and wrapping
 * every similarity search in an interactive transaction would pin a pool
 * connection for the duration of the search — the exact contention we're
 * trying to remove. Setting them at connection time means every `$queryRaw`
 * gets them for free.
 */
function startupOptions(t: PoolTuning): string {
  const opts = [`-c hnsw.ef_search=${t.efSearch}`]
  if (t.statementTimeoutMs > 0) opts.push(`-c statement_timeout=${t.statementTimeoutMs}`)
  return opts.join(' ')
}

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

  constructor(
    connectionString: string,
    private readonly tuning: PoolTuning,
  ) {
    super({
      adapter: new PrismaPg({
        connectionString,
        max: tuning.max,
        idleTimeoutMillis: tuning.idleTimeoutMs,
        connectionTimeoutMillis: tuning.connectionTimeoutMs,
        options: startupOptions(tuning),
      }),
    })
  }

  async onModuleInit() {
    await this.$connect()
    this.logger.log(
      `Prisma connected (pool max=${this.tuning.max}, ` +
        `hnsw.ef_search=${this.tuning.efSearch}, ` +
        `statement_timeout=${this.tuning.statementTimeoutMs}ms).`,
    )
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
