import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common'
import { DistributionListService } from './distribution-list.service.js'

/**
 * Read-only API for the Sidebar's Document tab.
 *
 *   GET /api/distribution-lists           — all known distribution lists
 *   GET /api/distribution-lists/:id       — one list with full detail
 *   GET /api/distribution-lists/:id/items — that list's documents
 */
@Controller('distribution-lists')
export class DistributionListController {
  constructor(
    @Inject(DistributionListService) private readonly svc: DistributionListService,
  ) {}

  @Get()
  async list() {
    return { lists: await this.svc.listAllForApi() }
  }

  @Get(':id')
  async one(@Param('id') id: string) {
    const row = await this.svc.getByIdForApi(id)
    if (!row) throw new NotFoundException(`distribution list ${id} not found`)
    return row
  }

  @Get(':id/items')
  async items(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    const list = await this.svc.getByIdForApi(id)
    if (!list) throw new NotFoundException(`distribution list ${id} not found`)
    const takeN = take ? Math.min(Math.max(parseInt(take, 10) || 100, 1), 500) : 100
    const rows = await this.svc.listItemsForApi(id, { cursor, take: takeN })
    const hasMore = rows.length > takeN
    const items = hasMore ? rows.slice(0, takeN) : rows
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : null,
    }
  }
}
