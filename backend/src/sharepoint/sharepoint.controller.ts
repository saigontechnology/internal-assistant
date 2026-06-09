import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Query,
  Req,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { SharepointService } from './sharepoint.service.js'

/**
 * All routes here are protected — SessionGuard rejects unauthenticated
 * requests before any handler runs, so `req.session` is always present.
 */
@Controller('sharepoint')
export class SharepointController {
  constructor(@Inject(SharepointService) private readonly sharepoint: SharepointService) {}

  private async token(req: Request): Promise<string> {
    const session = (req as Request & { session: Session }).session
    return this.sharepoint.tokenFor(session)
  }

  @Get('sites')
  async sites(@Req() req: Request) {
    try {
      const sites = await this.sharepoint.listSites(await this.token(req))
      return { sites }
    } catch (err) {
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Failed to list sites')
    }
  }

  @Get('drives')
  async drives(@Req() req: Request, @Query('siteId') siteId?: string) {
    if (!siteId) throw new BadRequestException('siteId query parameter required')
    try {
      const drives = await this.sharepoint.listDrives(await this.token(req), siteId)
      return { drives }
    } catch (err) {
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Failed to list drives')
    }
  }

  @Get('search')
  async search(@Req() req: Request, @Query('q') q?: string, @Query('from') from?: string) {
    try {
      const fromN = Number(from ?? 0)
      return await this.sharepoint.searchFiles(await this.token(req), q ?? '', Number.isFinite(fromN) ? fromN : 0)
    } catch (err) {
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Search failed')
    }
  }

  @Get('files')
  async files(
    @Req() req: Request,
    @Query('siteId') siteId?: string,
    @Query('driveId') driveId?: string,
    @Query('folderId') folderId?: string,
  ) {
    if (!siteId || !driveId) {
      throw new BadRequestException('siteId and driveId query parameters required')
    }
    try {
      const files = await this.sharepoint.listFiles(await this.token(req), siteId, driveId, folderId || undefined)
      return { files }
    } catch (err) {
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Failed to list files')
    }
  }
}
