import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  PreconditionFailedException,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import { SessionService } from '../auth/session.service.js'
import { DistributionListService } from '../sharepoint-list/distribution-list.service.js'
import { DelegatedGraphTokenProvider } from '../sharepoint-list/graph-token-provider.js'
import {
  AlreadyRunningError,
  ListWatcherService,
  UnknownListError,
} from '../sharepoint-list/list-watcher.service.js'
import {
  parseSharepointListUrl,
  SharepointListService,
} from '../sharepoint-list/sharepoint-list.service.js'

interface CreateListBody {
  displayName?: string
  note?: string | null
  listUrl?: string
}

interface UpdateListBody extends CreateListBody {
  enabled?: boolean
}

/**
 * `/api/admin/distribution-lists` — CRUD over the document-source lists.
 *
 * These rows replace the old SharePoint "registry list": the DB is the source
 * of truth, and the watcher iterates whatever lives here. `import-registry`
 * exists so an existing deployment can lift its registry into the DB once.
 */
@Controller('admin/distribution-lists')
@UseGuards(AdminGuard)
export class AdminListsController {
  constructor(
    @Inject(DistributionListService) private readonly lists: DistributionListService,
    @Inject(SharepointListService) private readonly listSvc: SharepointListService,
    @Inject(ListWatcherService) private readonly watcher: ListWatcherService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get('/')
  async list() {
    return { lists: await this.lists.listAllForApi() }
  }

  @Post('/')
  async create(@Req() req: Request, @Body() body: CreateListBody) {
    const displayName = (body.displayName ?? '').trim()
    const listUrl = (body.listUrl ?? '').trim()
    if (!displayName) throw new BadRequestException('displayName is required')
    if (!listUrl) throw new BadRequestException('listUrl is required')
    if (!parseSharepointListUrl(listUrl)) {
      throw new BadRequestException(
        'listUrl is not a recognizable SharePoint list URL (expected e.g. ' +
          'https://<tenant>.sharepoint.com/sites/<site>/Lists/<ListName>)',
      )
    }
    const duplicate = await this.lists.findByListUrl(listUrl)
    if (duplicate) {
      throw new ConflictException(`That list URL is already registered as "${duplicate.displayName}"`)
    }

    const session = (req as Request & { session: Session }).session
    const target = await this.listSvc.resolveTargetList(
      new DelegatedGraphTokenProvider(session, this.sessions),
      listUrl,
    )
    // The URL parsed but Graph couldn't reach the list. Refuse rather than
    // persisting a row that will never sync — the admin gets to fix the URL or
    // their permissions now, instead of discovering it on the next sync run.
    if (!target) {
      throw new UnprocessableEntityException(
        'Could not resolve that URL to a SharePoint list. Check the URL, and that ' +
          'your account can read the list.',
      )
    }

    const created = await this.lists.create({
      displayName,
      note: body.note?.trim() || null,
      listUrl,
      target,
      createdByEmail: session.username,
    })
    return { list: created }
  }

  @Patch(':id')
  async update(@Req() req: Request, @Param('id') id: string, @Body() body: UpdateListBody) {
    const existing = await this.lists.getByIdForApi(id)
    if (!existing) throw new NotFoundException(`No distribution list with id ${id}`)

    const patch: Parameters<DistributionListService['update']>[1] = {}

    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim()
      if (!displayName) throw new BadRequestException('displayName cannot be empty')
      patch.displayName = displayName
    }
    if (body.note !== undefined) patch.note = body.note?.trim() || null
    if (body.enabled !== undefined) patch.enabled = body.enabled

    // Only re-resolve when the URL actually changed — resolution is a Graph
    // round-trip, and a no-op PATCH shouldn't pay for it.
    const listUrl = body.listUrl?.trim()
    if (listUrl && listUrl !== existing.listUrl) {
      if (!parseSharepointListUrl(listUrl)) {
        throw new BadRequestException('listUrl is not a recognizable SharePoint list URL')
      }
      const duplicate = await this.lists.findByListUrl(listUrl, id)
      if (duplicate) {
        throw new ConflictException(
          `That list URL is already registered as "${duplicate.displayName}"`,
        )
      }
      const session = (req as Request & { session: Session }).session
      const target = await this.listSvc.resolveTargetList(
        new DelegatedGraphTokenProvider(session, this.sessions),
        listUrl,
      )
      if (!target) {
        throw new UnprocessableEntityException(
          'Could not resolve that URL to a SharePoint list. Check the URL, and that ' +
            'your account can read the list.',
        )
      }
      patch.listUrl = listUrl
      patch.target = target
    }

    return { list: await this.lists.update(id, patch) }
  }

  /**
   * Hard delete. Cascades distribution_list_items and the profile edges. The
   * documents themselves stay in `resources` until the next full sync demotes
   * them to pending_access — they're no longer reachable from any live list.
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    const existing = await this.lists.getByIdForApi(id)
    if (!existing) throw new NotFoundException(`No distribution list with id ${id}`)
    await this.lists.remove(id)
    return {
      message:
        'Distribution list deleted. Its documents drop out of chat retrieval on the next sync.',
      id,
    }
  }

  @Post(':id/sync')
  async syncOne(@Req() req: Request, @Param('id') id: string) {
    const session = (req as Request & { session: Session }).session
    const tokenProvider = new DelegatedGraphTokenProvider(session, this.sessions)
    try {
      return await this.watcher.syncList(tokenProvider, id)
    } catch (err) {
      if (err instanceof UnknownListError) throw new NotFoundException(err.message)
      if (err instanceof AlreadyRunningError) {
        throw new ConflictException('A sync is already running')
      }
      const msg = (err as Error).message ?? ''
      if (/401|403|invalid_grant|interaction_required/i.test(msg)) {
        throw new PreconditionFailedException(`SharePoint access not available: ${msg}`)
      }
      throw err
    }
  }

  /**
   * One-shot migration off the legacy SharePoint registry list named by
   * SHAREPOINT_LIST_NAME. Idempotent: rows already imported are matched on
   * (registryListId, registryItemId) and refreshed rather than duplicated.
   */
  @Post('import-registry')
  async importRegistry(@Req() req: Request) {
    const session = (req as Request & { session: Session }).session
    const tokens = new DelegatedGraphTokenProvider(session, this.sessions)

    let registry
    try {
      registry = await this.listSvc.resolveRegistry(tokens)
    } catch (err) {
      throw new UnprocessableEntityException(
        `Could not read the registry list: ${(err as Error).message}`,
      )
    }

    const startedAt = new Date()
    let created = 0
    let updated = 0
    let unresolved = 0
    for (const row of registry.rows) {
      const target = await this.listSvc.resolveTargetList(tokens, row.listUrl)
      if (!target) unresolved++
      const result = await this.lists.upsertRegistryRow({
        registryListId: registry.registryListId,
        row,
        target,
        syncStartedAt: startedAt,
      })
      if (result.created) created++
      else updated++
    }

    return { rowsSeen: registry.rows.length, created, updated, unresolved }
  }
}
