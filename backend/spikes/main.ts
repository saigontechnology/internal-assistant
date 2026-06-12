/**
 * Day-1 spike harness — one Nest app, three controllers, run via `npm run spike`.
 *
 * Spike A: GET /spike-a/stream         — Nest @Res() streaming via AI SDK pipeUIMessageStreamToResponse
 * Spike B: GET /spike-b/halfvec         — Prisma $queryRaw against existing pgvector data
 * Spike C: GET /spike-c/cookie/set      — Express cookie-parser signed cookies round trip
 *          GET /spike-c/cookie/read
 *          GET /spike-c/cookie/tamper
 */
import 'reflect-metadata'
import { Controller, Get, Module, Req, Res } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import type { Request, Response } from 'express'
import cookieParser from 'cookie-parser'
import 'dotenv/config'
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai'
// @ts-ignore — generator output is local-only
import { PrismaClient } from '../node_modules/.prisma/spike-client/index.js'
import { PrismaPg } from '@prisma/adapter-pg'
import { buildDatabaseUrl } from '../src/config/database-url.js'

const COOKIE_SECRET = 'spike-secret-do-not-use-in-prod'
const adapter = new PrismaPg({ connectionString: buildDatabaseUrl() })
const prisma = new PrismaClient({ adapter })

// ─────────────────────────────────────────────── Spike A ─────
@Controller('spike-a')
class SpikeAController {
  @Get('stream')
  stream(@Res() res: Response) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageId: 'spike-a-1' })
        writer.write({ type: 'text-start', id: 't1' })
        for (const chunk of ['Hello ', 'from ', 'NestJS ', '+ ', 'AI SDK ', 'streaming!']) {
          writer.write({ type: 'text-delta', id: 't1', delta: chunk })
          await new Promise(r => setTimeout(r, 80))
        }
        writer.write({ type: 'text-end', id: 't1' })
        writer.write({ type: 'finish' })
      },
    })
    pipeUIMessageStreamToResponse({ response: res, stream })
  }
}

// ─────────────────────────────────────────────── Spike B ─────
@Controller('spike-b')
class SpikeBController {
  @Get('halfvec')
  async halfvec() {
    // 2048-dim zero vector cast to halfvec — same shape as production embedding column.
    const dim = 2048
    const vec = '[' + new Array(dim).fill(0).join(',') + ']'

    // 1) Does Prisma let us SELECT a halfvec column at all?
    const sampleCount = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM embeddings
    `

    // 2) Does pgvector's <=> distance operator accept a halfvec cast inside $queryRaw?
    //    This is THE production query pattern. We don't care about results — only that it parses + runs.
    const top = await prisma.$queryRaw<
      { id: string; resource_id: string; similarity: number }[]
    >`
      SELECT id, resource_id,
             (1 - (embedding <=> ${vec}::halfvec))::float AS similarity
      FROM embeddings
      ORDER BY embedding <=> ${vec}::halfvec
      LIMIT 5
    `

    // 3) Confirm the HNSW index is in pg_indexes (proof Prisma migrate would have to add it via raw SQL).
    const indexes = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'embeddings'
    `

    return {
      ok: true,
      embeddingRows: Number(sampleCount[0]?.count ?? 0n),
      topKReturned: top.length,
      indexes: indexes.map(i => ({ name: i.indexname, def: i.indexdef.slice(0, 120) })),
    }
  }
}

// ─────────────────────────────────────────────── Spike C ─────
@Controller('spike-c/cookie')
class SpikeCController {
  @Get('set')
  set(@Res() res: Response) {
    res.cookie('spike_session', JSON.stringify({ uid: 'u-123', role: 'admin' }), {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60_000,
    })
    res.json({ ok: true, set: 'spike_session (signed)' })
  }

  @Get('read')
  read(@Req() req: Request) {
    const signed = req.signedCookies['spike_session']
    return { ok: signed !== undefined, signedCookie: signed ?? null, raw: req.cookies['spike_session'] ?? null }
  }

  @Get('tamper')
  tamper(@Req() req: Request) {
    // cookie-parser splits signed-prefixed cookies (s:…) into `signedCookies`.
    // A tampered signature surfaces as `false` (the documented behavior).
    const verdict = req.signedCookies['spike_session']
    return {
      ok: true,
      tamperDetected: verdict === false,
      verdict,
      explanation: 'cookie-parser sets req.signedCookies[name] = false when signature fails',
    }
  }
}

// ─────────────────────────────────────────────── Bootstrap ──
@Module({ controllers: [SpikeAController, SpikeBController, SpikeCController] })
class SpikeModule {}

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(SpikeModule, { logger: ['error', 'warn', 'log'] })
  app.use(cookieParser(COOKIE_SECRET))
  await app.listen(7777)
  console.log('Spike harness on http://localhost:7777')
}
main().catch(e => { console.error(e); process.exit(1) })
