import {
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AppConfig } from '../config/app-config.service.js'
import { UserPermissionService } from './user-permission.service.js'
import { UserSyncQueue } from './user-sync.queue.js'
import { UserSyncService } from './user-sync.service.js'

/**
 * Public surface for the per-user setup + weekly refresh flow.
 *
 * Privacy:
 *  - GET /api/user/permission never exposes `listUnauthorized` itself, only
 *    `unauthorizedCount`.
 *  - GET /api/user/sync/status only returns the caller's own queue slot
 *    (position + progress); other users' emails are never returned.
 */
@Controller('user')
export class UserPermissionController {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(UserPermissionService) private readonly perms: UserPermissionService,
    @Inject(UserSyncQueue) private readonly queue: UserSyncQueue,
    @Inject(UserSyncService) private readonly sync: UserSyncService,
  ) {}

  /**
   * GET /api/user/permission
   *
   * Reads (and lazy-creates) the caller's user_permissions row. Side effects:
   *   - Heals a stuck `syncing_started_at` older than UserSyncService.STUCK_THRESHOLD_MS.
   *   - Auto-enqueues a background sync when `lastSync` is older than the
   *     configured weekly window AND no job is in flight for this user.
   */
  @Get('permission')
  async get(@Req() req: Request) {
    const session = sessionOf(req)
    const email = session.username
    if (!email) return { error: 'session_has_no_email' }

    await this.perms.healStale(email, UserSyncService.STUCK_THRESHOLD_MS)
    const row = await this.perms.ensure(email)

    // Weekly auto-resync trigger. Only fires when the row already exists with
    // a lastSync (first-time setup is initiated by POST /api/user/sync from
    // the Begin Setup button).
    const intervalMs = this.config.userSyncIntervalDays * 24 * 60 * 60 * 1000
    const stale = row.lastSync && Date.now() - row.lastSync.getTime() >= intervalMs
    if (stale && !row.firstSyncing && this.queue.state(email) === 'idle') {
      this.sync.enqueueFor(session)
    }

    const unauthorizedCount = row.listUnauthorized
      ? row.listUnauthorized.split(',').filter(Boolean).length
      : 0
    const syncing = this.queue.state(email) !== 'idle' || row.syncingStartedAt !== null

    return {
      email,
      firstSyncing: row.firstSyncing,
      hasRecord: true,
      lastSync: row.lastSync ? row.lastSync.toISOString() : null,
      unauthorizedCount,
      syncing,
    }
  }

  /**
   * POST /api/user/sync
   *
   * Idempotent. Creates the row if missing (firstSyncing=true) and enqueues
   * the per-user job. Returns the immediate queue verdict.
   */
  @Post('sync')
  async start(@Req() req: Request) {
    const session = sessionOf(req)
    if (!session.username) return { error: 'session_has_no_email' }

    await this.perms.ensure(session.username)
    const verdict = this.sync.enqueueFor(session)
    return { status: verdict }
  }

  /**
   * GET /api/user/sync/status
   *
   * Drives the FirstTimeSetup screen. Returns only the caller's slot.
   */
  @Get('sync/status')
  async status(@Req() req: Request) {
    const session = sessionOf(req)
    const email = session.username
    if (!email) return { error: 'session_has_no_email' }

    const row = await this.perms.ensure(email)
    const queueState = this.queue.state(email)

    const itemsSeen = row.itemsSeen ?? 0
    const itemsTotal = row.itemsTotal ?? null
    const progressPercent =
      itemsTotal && itemsTotal > 0
        ? Math.min(100, Math.round((100 * itemsSeen) / itemsTotal))
        : 0

    const state: 'idle' | 'queued' | 'running' | 'done' =
      queueState !== 'idle'
        ? queueState
        : row.firstSyncing
          ? 'idle'
          : 'done'

    return {
      state,
      yourPosition: queueState === 'queued' ? this.queue.positionOf(email) : null,
      queueLength: this.queue.queueLength(),
      progressPercent,
      itemsSeen,
      itemsTotal,
      startedAt: row.syncingStartedAt ? row.syncingStartedAt.toISOString() : null,
      lastError: row.lastError,
    }
  }
}

function sessionOf(req: Request): Session {
  return (req as Request & { session: Session }).session
}
