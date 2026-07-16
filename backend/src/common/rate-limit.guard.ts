import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import type { Request } from 'express'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'

/** Window length for both budgets. */
const WINDOW_MS = 60_000

/**
 * How often expired buckets are swept. Without this the map is a slow memory
 * leak keyed by every IP that ever touched the server.
 */
const SWEEP_MS = 60_000

interface Bucket {
  /** Request timestamps inside the current window, oldest first. */
  hits: number[]
  chatHits: number[]
}

/**
 * Per-caller sliding-window rate limit.
 *
 * The app had no limit of any kind, which at 100 concurrent users means a
 * single misbehaving tab — a retry loop, a stuck `useChat`, a script — can
 * consume the whole model-provider budget and the whole connection pool, and
 * everyone else just sees a slow app with nothing in the logs to explain it.
 *
 * Two budgets, because one number can't describe both kinds of traffic: a page
 * load costs a couple of indexed reads, while a chat turn costs a model call,
 * several embedding calls, and a vector scan per retrieval. Allowing 120 of
 * either per minute would be far too tight for the first and absurdly loose for
 * the second.
 *
 * Keyed on the session cookie, falling back to client IP for unauthenticated
 * requests (the login route). Note the fallback is coarse: everyone behind one
 * corporate NAT shares an IP, so the pre-auth budget is shared too — that's
 * acceptable for /api/auth/* and would not be for anything else.
 *
 * Runs *before* SessionGuard, deliberately: rate-limiting after authentication
 * would mean every rejected request had already paid for the session lookup and
 * the account-state read, which is exactly the load we're shedding.
 *
 * In-memory, so the budget is per backend process. That is correct today (one
 * Nest instance) and would need to move to Redis before scaling out — the
 * counters, unlike the resumable streams, are not shared.
 */
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>()
  private sweeper: NodeJS.Timeout | null = null

  constructor(private readonly settings: RuntimeSettingsService) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS)
    // Don't hold the event loop open in tests / short-lived processes.
    this.sweeper.unref()
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== 'http') return true

    const req = ctx.switchToHttp().getRequest<Request>()

    // The health endpoint is what the container healthcheck and any uptime
    // monitor poll. Rate-limiting it would eventually mark a busy — but
    // healthy — server as down and restart it, which is the opposite of help.
    if (req.path === '/api/health' || req.path === '/health') return true

    const generalLimit = this.settings.rateLimitPerMinute
    const chatLimit = this.settings.chatRateLimitPerMinute
    if (generalLimit === 0 && chatLimit === 0) return true

    const now = Date.now()
    const key = this.callerKey(req)
    const bucket = this.buckets.get(key) ?? { hits: [], chatHits: [] }

    prune(bucket.hits, now)
    prune(bucket.chatHits, now)

    // POST /api/chat is the only route that starts a generation. Resuming a
    // stream (GET) and stopping one (POST .../stop) cost nothing, so they take
    // the general budget rather than the chat one.
    const isChatTurn = req.method === 'POST' && /^\/api\/chat\/?$/.test(req.path)

    if (generalLimit > 0 && bucket.hits.length >= generalLimit) {
      this.buckets.set(key, bucket)
      throw tooManyRequests(bucket.hits, now)
    }
    if (isChatTurn && chatLimit > 0 && bucket.chatHits.length >= chatLimit) {
      this.buckets.set(key, bucket)
      throw tooManyRequests(bucket.chatHits, now)
    }

    bucket.hits.push(now)
    if (isChatTurn) bucket.chatHits.push(now)
    this.buckets.set(key, bucket)
    return true
  }

  /**
   * Session first, IP second. Reading the raw cookie rather than verifying it
   * is fine here and is the point — we want to charge a request *before*
   * spending a database round-trip proving who sent it. A forged cookie value
   * only ever costs the forger their own budget.
   */
  private callerKey(req: Request): string {
    const sid = req.cookies?.sid ?? req.signedCookies?.sid
    if (typeof sid === 'string' && sid.length > 0) return `s:${sid}`
    return `ip:${req.ip ?? 'unknown'}`
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) {
      prune(bucket.hits, now)
      prune(bucket.chatHits, now)
      if (bucket.hits.length === 0 && bucket.chatHits.length === 0) {
        this.buckets.delete(key)
      }
    }
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper)
  }
}

/** Drop timestamps that have fallen out of the window. In place, oldest first. */
function prune(hits: number[], now: number): void {
  const cutoff = now - WINDOW_MS
  let drop = 0
  while (drop < hits.length && hits[drop]! <= cutoff) drop++
  if (drop > 0) hits.splice(0, drop)
}

/**
 * 429 with a `Retry-After` derived from when the oldest hit leaves the window —
 * i.e. the earliest moment a retry could actually succeed. Clients that respect
 * it stop hammering; clients that don't get rejected cheaply.
 */
function tooManyRequests(hits: number[], now: number): HttpException {
  const oldest = hits[0] ?? now
  const retryAfterS = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000))
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message: 'Too many requests. Please slow down and try again shortly.',
      retryAfter: retryAfterS,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  )
}
