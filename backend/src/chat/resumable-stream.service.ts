import { createClient, type RedisClientType } from 'redis'
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream'
import { AppConfig } from '../config/app-config.service.js'

/**
 * Owns the Redis pub/sub pair backing `resumable-stream` and the shared
 * ResumableStreamContext used by the chat routes.
 *
 * We create explicit publisher + subscriber clients (rather than letting
 * the library spin them up from REDIS_URL) so we can:
 *   - point at our AppConfig-resolved URL instead of process.env leaks,
 *   - hook Nest's onModuleDestroy for a clean shutdown,
 *   - surface connection errors as logs instead of unhandled promise rejections.
 *
 * `waitUntil` in a long-lived Nest/Express server is a no-op: the process
 * doesn't get suspended between requests the way a serverless function does,
 * so a fire-and-forget promise is enough to keep the stream draining.
 */
export class ResumableStreamService {
  private publisher: RedisClientType | null = null
  private subscriber: RedisClientType | null = null
  private context: ResumableStreamContext | null = null
  private initPromise: Promise<ResumableStreamContext> | null = null

  constructor(private readonly config: AppConfig) {}

  /**
   * Lazily connect on first use. Concurrent callers share a single
   * connect() promise so we don't spin up multiple client pairs during
   * the request burst that follows cold start.
   */
  async getContext(): Promise<ResumableStreamContext> {
    if (this.context) return this.context
    if (this.initPromise) return this.initPromise
    this.initPromise = this.init()
    try {
      this.context = await this.initPromise
      return this.context
    } finally {
      this.initPromise = null
    }
  }

  private async init(): Promise<ResumableStreamContext> {
    const url = this.config.redisUrl
    const publisher: RedisClientType = createClient({ url })
    const subscriber: RedisClientType = publisher.duplicate()

    publisher.on('error', (err) => console.error('[redis:publisher]', err))
    subscriber.on('error', (err) => console.error('[redis:subscriber]', err))

    await Promise.all([publisher.connect(), subscriber.connect()])

    this.publisher = publisher
    this.subscriber = subscriber

    return createResumableStreamContext({
      // Long-lived Node server: the process stays alive as long as the
      // stream is draining, no platform hand-off required.
      waitUntil: null,
      publisher,
      subscriber,
    })
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.publisher?.quit(),
      this.subscriber?.quit(),
    ])
    this.publisher = null
    this.subscriber = null
    this.context = null
  }
}
