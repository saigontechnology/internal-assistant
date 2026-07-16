import 'reflect-metadata'
import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import { AppModule } from './app.module.js'
import { ActiveStreamRegistry } from './chat/active-stream-registry.js'
import { AppConfig } from './config/app-config.service.js'

const PORT = Number(process.env.PORT ?? 8000)

/** Polling interval while waiting for in-flight streams to finish. */
const DRAIN_POLL_MS = 500

// Bootstrap the NestJS application
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  })
  const config = app.get(AppConfig)

  app.setGlobalPrefix('api')
  // Signed-cookie secret must match the one MSAL's auth_tx cookie was set with.
  app.use(cookieParser(config.sessionSecret))
  app.enableCors({
    origin: config.frontendUrl,
    credentials: true,
  })

  // Nest won't call onModuleDestroy without this, so the Redis pub/sub pair and
  // the Prisma pool were previously never closed cleanly — the process just
  // died and the sockets went with it.
  app.enableShutdownHooks()

  // Every deploy recreates this container. Without a drain, SIGTERM kills the
  // process mid-token and every user currently reading an answer loses it —
  // and, because the kill lands before onFinish, `active_stream_id` stays set,
  // so their next message hits the 409 concurrent-send guard on a stream that
  // no longer exists. Wait for generations to finish; abort whatever is left.
  const registry = app.get(ActiveStreamRegistry)
  let shuttingDown = false

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    const deadline = Date.now() + config.shutdownDrainTimeoutMs
    if (registry.size > 0) {
      console.log(
        `[shutdown] ${signal}: draining ${registry.size} in-flight stream(s), ` +
          `up to ${config.shutdownDrainTimeoutMs}ms`,
      )
    }
    while (registry.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS))
    }

    const stranded = registry.abortAll()
    if (stranded > 0) {
      console.warn(`[shutdown] drain timed out; aborted ${stranded} stream(s) still running`)
    }

    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen(PORT)
  console.log(`Internal Assistant backend running on http://localhost:${PORT}`)
}
bootstrap().catch((e) => { console.error(e); process.exit(1) })
