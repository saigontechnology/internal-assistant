import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  PreconditionFailedException,
  Post,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import { SessionService } from '../auth/session.service.js'
import { SyncAllowlistService } from '../auth/sync-allowlist.service.js'
import { DelegatedGraphTokenProvider } from './graph-token-provider.js'
import { AlreadyRunningError, ListWatcherService } from './list-watcher.service.js'
import { SharepointListService } from './sharepoint-list.service.js'

/**
 * Manual sync trigger + status read endpoint. Both require an authed session
 * — Phase A uses the requesting user's delegated Graph token to call Graph.
 */
@Controller('sync')
export class SyncController {
  constructor(
    @Inject(ListWatcherService) private readonly watcher: ListWatcherService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SharepointListService) private readonly listSvc: SharepointListService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SyncAllowlistService) private readonly allowlist: SyncAllowlistService,
  ) {}

  @Post()
  async start(@Req() req: Request) {
    const session = (req as Request & { session: Session }).session
    if (!(await this.allowlist.isAllowed(session.username))) {
      throw new ForbiddenException('This account is not permitted to trigger a sync')
    }
    const tokenProvider = new DelegatedGraphTokenProvider(session, this.sessions)

    try {
      // Run synchronously and return the summary in the response. Sync takes
      // ~tens of seconds on the 375-row test list; tolerable for a manual
      // button. If it ever needs to be async, return 202 + a job id here.
      const summary = await this.watcher.sync(tokenProvider, 'manual')
      return summary
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        throw new ConflictException('A sync is already running')
      }
      // A delegated-token Graph error early in the sync (e.g. the session's
      // Graph token can't be refreshed) — surface 412 so the UI prompts the
      // user to sign out + back in. Matches the contract in plan §7.
      const msg = (err as Error).message ?? ''
      if (/401|403|invalid_grant|interaction_required/i.test(msg)) {
        throw new PreconditionFailedException(`SharePoint access not available: ${msg}`)
      }
      throw err
    }
  }

  @Get('status')
  async status(@Req() req: Request) {
    // Same gate as the trigger: sync status (per-list state, index totals,
    // error strings) is operational metadata that only sync-permitted users
    // should see, not every authenticated user.
    const session = (req as Request & { session: Session }).session
    if (!(await this.allowlist.isAllowed(session.username))) {
      throw new ForbiddenException('This account is not permitted to view sync status')
    }

    // All per-list WatcherState rows, newest first. Multi-list means one row
    // per known list; the UI can render them as a table.
    const states = await this.prisma.watcherState.findMany({ orderBy: { lastRunAt: 'desc' } })

    // Live totals from the resources table — these answer the question
    // "what's the current state of the index?" which the per-run counters
    // ("how much work did the last sync do?") don't.
    const totals = await this.prisma.resource.groupBy({
      by: ['syncStatus'],
      where: { sharepointCode: { not: null } },
      _count: { _all: true },
    })
    const totalsByStatus: Record<string, number> = {
      synced: 0, pending_access: 0, failed_parse: 0, failed_resolve: 0,
    }
    for (const t of totals) totalsByStatus[t.syncStatus] = t._count._all

    return {
      running: this.watcher.isRunning(),
      currentStartedAt: this.watcher.getCurrentStart(),
      lastRun: this.watcher.getLastRun(),
      persistedState: states,
      indexState: totalsByStatus,
    }
  }
}
