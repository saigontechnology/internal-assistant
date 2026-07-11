import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { ViewerAccessService } from '../access/viewer-access.service.js'
import { DistributionListService } from './distribution-list.service.js'

/**
 * Read-only API for the Sidebar's Document tab. Reachable by any authenticated
 * user, so every route filters to the caller's job-profile allow-list (same
 * model as chat retrieval) — a user never sees lists, document titles/codes, or
 * SharePoint URLs outside their access scope. A list the caller can't see
 * returns 404 (not 403) so its existence isn't confirmed.
 *
 *   GET /api/distribution-lists           — lists the caller can access
 *   GET /api/distribution-lists/:id       — one accessible list with detail
 *   GET /api/distribution-lists/:id/items — that list's accessible documents
 */
@Controller('distribution-lists')
export class DistributionListController {
  constructor(
    @Inject(DistributionListService) private readonly svc: DistributionListService,
    @Inject(ViewerAccessService) private readonly viewer: ViewerAccessService,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const access = await this.viewer.resolve(session(req))
    return { lists: await this.svc.listAccessibleForApi(access) }
  }

  @Get(':id')
  async one(@Param('id') id: string, @Req() req: Request) {
    const access = await this.viewer.resolve(session(req))
    const visible = await this.svc.accessibleListIds(access)
    if (!visible.has(id)) throw new NotFoundException(`distribution list ${id} not found`)
    const row = await this.svc.getByIdForApi(id)
    if (!row) throw new NotFoundException(`distribution list ${id} not found`)
    return row
  }

  @Get(':id/items')
  async items(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    const access = await this.viewer.resolve(session(req))
    const visible = await this.svc.accessibleListIds(access)
    if (!visible.has(id)) throw new NotFoundException(`distribution list ${id} not found`)
    const takeN = take ? Math.min(Math.max(parseInt(take, 10) || 100, 1), 500) : 100
    const rows = await this.svc.listItemsForApi(id, { cursor, take: takeN, access })
    const hasMore = rows.length > takeN
    const items = hasMore ? rows.slice(0, takeN) : rows
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
    }
  }
}

function session(req: Request): Session {
  return (req as Request & { session: Session }).session
}
