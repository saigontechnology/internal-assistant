/**
 * Smoke test the resumable-stream + Redis wiring without touching the LLM
 * or the chat controller. Registers a slow-producing stream, disconnects
 * the first consumer, and reconnects a second consumer to prove the
 * producer kept running and buffered the chunks in Redis.
 *
 * Run: npx tsx scripts/smoke-resumable-stream.ts
 */
import 'dotenv/config'
import { createClient, type RedisClientType } from 'redis'
import { createResumableStreamContext } from 'resumable-stream'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

async function readAll(stream: ReadableStream<string>, tag: string): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    out += value
    console.log(`[${tag}] chunk:`, JSON.stringify(value))
  }
  return out
}

async function main() {
  console.log(`Connecting to Redis at ${REDIS_URL} …`)
  const publisher: RedisClientType = createClient({ url: REDIS_URL })
  const subscriber: RedisClientType = publisher.duplicate()
  publisher.on('error', (e) => console.error('[pub]', e))
  subscriber.on('error', (e) => console.error('[sub]', e))
  await Promise.all([publisher.connect(), subscriber.connect()])
  console.log('  ok')

  const ctx = createResumableStreamContext({ waitUntil: null, publisher, subscriber })
  const streamId = `smoke-${Date.now()}`
  console.log(`streamId: ${streamId}`)

  // Slow producer: emits 6 chunks, 300ms apart. Total ~1.8s. We'll drop
  // the first consumer after ~500ms and reconnect a second one.
  const makeStream = () =>
    new ReadableStream<string>({
      async start(controller) {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 300))
          controller.enqueue(`chunk-${i}\n`)
        }
        controller.close()
      },
    })

  console.log('\n[stage 1] createNewResumableStream + first consumer')
  const producedStream = await ctx.createNewResumableStream(streamId, makeStream)
  if (!producedStream) throw new Error('producer returned null')

  // First consumer: cancel after 500ms to simulate a client disconnect.
  const firstController = new AbortController()
  const firstReaderPromise = (async () => {
    const reader = producedStream.getReader()
    firstController.signal.addEventListener('abort', () => {
      reader.cancel().catch(() => {})
    })
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        console.log('[first ] chunk:', JSON.stringify(value))
      }
    } catch (err) {
      console.log('[first ] read errored (expected on cancel):', (err as Error).message)
    }
  })()
  setTimeout(() => {
    console.log('[first ] disconnecting…')
    firstController.abort()
  }, 500)
  await firstReaderPromise

  console.log('\n[stage 2] reconnect via resumeExistingStream')
  const resumed = await ctx.resumeExistingStream(streamId)
  if (!resumed) {
    console.error('resumeExistingStream returned null/undefined — nothing to resume')
    process.exit(1)
  }
  const secondText = await readAll(resumed, 'second')

  console.log('\n[result] second consumer received:')
  console.log(secondText.trim())
  const expected = 'chunk-0\nchunk-1\nchunk-2\nchunk-3\nchunk-4\nchunk-5'
  if (secondText.trim() !== expected) {
    console.error('  MISMATCH — expected:\n' + expected)
    process.exit(2)
  }
  console.log('\n✓ Resume worked: second consumer got the full stream after the first disconnected.')

  await Promise.allSettled([publisher.quit(), subscriber.quit()])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
