/**
 * Day-5 smoke test: bootstrap the chat stack and stream a real response.
 *
 *   1. Upload a tiny doc so RAG has something to find.
 *   2. POST /api/chat with a UI message asking about that doc.
 *   3. Read the SSE stream and assert we see the expected wire format
 *      (start / text-delta / finish / [DONE]).
 *   4. Cleanup.
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
import { SharepointModule } from '../src/sharepoint/sharepoint.module.js'
import { DocumentsModule } from '../src/documents/documents.module.js'
import { ChatModule } from '../src/chat/chat.module.js'

@Module({
  imports: [
    AppConfigModule, PrismaModule, AuthModule,
    EmbeddingsModule, SharepointModule, DocumentsModule, ChatModule,
  ],
})
class SmokeModule {}

const PORT = 7780

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(SmokeModule, { logger: ['error', 'warn'] })
  app.use(cookieParser(app.get(AppConfig).sessionSecret))
  app.setGlobalPrefix('api')
  await app.listen(PORT)
  const base = `http://localhost:${PORT}/api`

  // 1) seed a tiny doc
  const txt = 'The Day-5 chat smoke test verifies SSE streaming through the new NestJS controller.'
  const form = new FormData()
  form.append('file', new File([txt], 'day5-smoke.txt', { type: 'text/plain' }))
  const up = await fetch(`${base}/documents/upload`, { method: 'POST', body: form })
  const uploaded = await up.json() as { id: string }
  console.log(`upload → ${up.status} id=${uploaded.id}`)

  try {
    // 2) chat
    const userMessage = {
      id: 'm1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'What does the Day-5 smoke test verify?' }],
    }
    const r = await fetch(`${base}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [userMessage] }),
    })
    console.log(`chat   → ${r.status} ${r.headers.get('content-type')}`)

    // 3) read the SSE stream, tally event types
    const reader = r.body!.getReader()
    const decoder = new TextDecoder()
    const events: string[] = []
    let raw = ''
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value!.length
      const chunk = decoder.decode(value!, { stream: true })
      raw += chunk
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') { events.push('[DONE]'); continue }
        try {
          const e = JSON.parse(payload)
          events.push(e.type as string)
        } catch { /* partial chunk */ }
      }
    }
    const counts: Record<string, number> = {}
    for (const t of events) counts[t] = (counts[t] ?? 0) + 1
    console.log(`stream → ${bytes} bytes, ${events.length} events`)
    console.log(`event types: ${JSON.stringify(counts)}`)
    const hasStart = events.includes('start')
    const hasFinish = events.includes('finish')
    const hasDone = events.includes('[DONE]')
    console.log(`shape  → start:${hasStart ? '✓' : '✗'} finish:${hasFinish ? '✓' : '✗'} [DONE]:${hasDone ? '✓' : '✗'}`)
    if (!hasStart || !hasFinish || !hasDone) {
      console.log('first 600 chars of raw stream:'); console.log(raw.slice(0, 600))
    }
  } finally {
    await fetch(`${base}/documents/${uploaded.id}`, { method: 'DELETE' })
    await app.close()
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
