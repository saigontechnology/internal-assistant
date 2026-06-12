/**
 * Day-4 smoke test: end-to-end upload → embed → similarity-search → delete
 * against the live DB. No SharePoint here — that needs a real signed-in
 * browser session; the docs/upload path exercises the same DocumentsService.
 *
 *   GET    /api/documents               → list current docs
 *   POST   /api/documents/upload        → multipart upload of a small .txt
 *   $queryRaw similarity search         → verify chunks landed in halfvec column
 *   DELETE /api/documents/<id>          → cleanup
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import { AppConfigModule } from '../src/config/config.module.js'
import { AppConfig } from '../src/config/app-config.service.js'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { AuthModule } from '../src/auth/auth.module.js'
import { EmbeddingsModule } from '../src/embeddings/embeddings.module.js'
import { EmbeddingsService } from '../src/embeddings/embeddings.service.js'
import { SharepointModule } from '../src/sharepoint/sharepoint.module.js'
import { DocumentsModule } from '../src/documents/documents.module.js'

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    EmbeddingsModule,
    SharepointModule,
    DocumentsModule,
  ],
})
class SmokeModule {}

const PORT = 7779

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(SmokeModule, { logger: ['error', 'warn'] })
  const config = app.get(AppConfig)
  app.use(cookieParser(config.sessionSecret))
  app.setGlobalPrefix('api')
  await app.listen(PORT)
  const base = `http://localhost:${PORT}/api`

  // 1) initial list
  const r1 = await fetch(`${base}/documents/`)
  const before = await r1.json() as { documents: { id: string }[] }
  console.log(`/documents (before)  → ${r1.status} count=${before.documents.length}`)

  // 2) upload a small .txt
  const txt = [
    'Postgres pgvector supports halfvec(2048) for memory-efficient embeddings.',
    'HNSW is an approximate nearest neighbor index well-suited for high-dim vectors.',
    'Drizzle ORM previously owned the schema; we migrated to Prisma 7 + adapter-pg.',
    'The Day-4 smoke test inserts this exact paragraph and queries it back via $queryRaw.',
  ].join('\n\n')
  const form = new FormData()
  form.append('file', new File([txt], 'day4-smoke.txt', { type: 'text/plain' }))
  const r2 = await fetch(`${base}/documents/upload`, { method: 'POST', body: form })
  const uploaded = await r2.json() as { id: string; filename: string; chunkCount: number }
  console.log(`/documents/upload    → ${r2.status} id=${uploaded.id} chunks=${uploaded.chunkCount}`)

  // 3) similarity search via the service directly (no HTTP — chat endpoint isn't ported yet)
  const embeddings = app.get(EmbeddingsService)
  const hits = await embeddings.similaritySearch('how does pgvector store half-precision vectors', { k: 3 })
  console.log(`similaritySearch     → ${hits.length} hit(s)`)
  hits.slice(0, 2).forEach((h, i) => {
    console.log(`  [${i}] from=${h.metadata.filename} :: ${(h.content as string).slice(0, 80)}…`)
  })

  // 4) confirm chunkCount via list
  const r3 = await fetch(`${base}/documents/`)
  const after = await r3.json() as { documents: { id: string; chunkCount: number; filename: string }[] }
  const ours = after.documents.find((d) => d.id === uploaded.id)
  console.log(`/documents (after)   → count=${after.documents.length}  ours.chunks=${ours?.chunkCount ?? 'MISSING'}`)

  // 5) delete + verify
  const r4 = await fetch(`${base}/documents/${uploaded.id}`, { method: 'DELETE' })
  console.log(`/documents/<id> DEL  → ${r4.status}`)
  const r5 = await fetch(`${base}/documents/`)
  const final = await r5.json() as { documents: { id: string }[] }
  const stillThere = final.documents.some((d) => d.id === uploaded.id)
  console.log(`row after delete     → ${stillThere ? 'STILL THERE ✗' : 'deleted ✓'}`)

  await app.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
