/**
 * Quick check: do the embeddings from the watcher's sync actually retrieve?
 * Calls EmbeddingsService.similaritySearch on a few seed queries and reports
 * the top hits + their source filenames.
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppConfigModule } from '../src/config/config.module.js'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { EmbeddingsModule } from '../src/embeddings/embeddings.module.js'
import { EmbeddingsService } from '../src/embeddings/embeddings.service.js'

@Module({ imports: [AppConfigModule, PrismaModule, EmbeddingsModule] })
class M {}

const app = await NestFactory.createApplicationContext(M, { logger: ['error', 'warn'] })
const embeddings = app.get(EmbeddingsService)

const queries = [
  'level definition for developer engineer',
  'work breakdown structure template',
  'risk-based supplier list',
]

for (const q of queries) {
  console.log(`\n── "${q}" ──`)
  const hits = await embeddings.similaritySearch(q, { k: 3 })
  if (!hits.length) { console.log('  (no hits)'); continue }
  for (const h of hits) {
    console.log(`  ◆ ${h.metadata.filename}`)
    console.log(`    ${String(h.content).slice(0, 120).replace(/\s+/g, ' ')}...`)
  }
}
await app.close()
