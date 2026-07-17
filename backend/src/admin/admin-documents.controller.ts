import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  PreconditionFailedException,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Prisma, Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import { SessionService } from '../auth/session.service.js'
import { DocumentsService } from '../documents/documents.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DelegatedGraphTokenProvider } from '../sharepoint-list/graph-token-provider.js'
import {
  AlreadyRunningError,
  ListWatcherService,
} from '../sharepoint-list/list-watcher.service.js'

const DEFAULT_TAKE = 50
const MAX_TAKE = 200

/** `/api/admin/documents` — document management. Admin-only. */
@Controller('admin/documents')
@UseGuards(AdminGuard)
export class AdminDocumentsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(ListWatcherService) private readonly watcher: ListWatcherService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Paginated resource list with embedding counts and owning distribution
   * lists. Unlike `GET /api/documents` this is NOT filtered by the caller's
   * job profile — an admin sees the whole index, including metadata-only rows
   * nobody has been able to fetch yet.
   *
   * Offset-paginated (`page` is 0-based) — the corpus is a few hundred rows,
   * so a cursor buys nothing here. The aggregate counts are computed over the
   * same filter so the stat cards describe the whole match, not just the
   * loaded page.
   */
  @Get('/')
  async list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('page') pageParam?: string,
  ) {
    const limit = Math.min(Math.max(Number(take) || DEFAULT_TAKE, 1), MAX_TAKE)
    const pageIndex = Math.max(Number(pageParam) || 0, 0)

    const where: Prisma.ResourceWhereInput = {
      ...(status ? { syncStatus: status } : {}),
      ...(q
        ? {
            OR: [
              { filename: { contains: q, mode: 'insensitive' } },
              { sharepointCode: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [page, total, pendingTotal, chunkTotal] = await Promise.all([
      this.prisma.resource.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: pageIndex * limit,
        take: limit,
        include: { _count: { select: { embeddings: true } } },
      }),
      this.prisma.resource.count({ where }),
      this.prisma.resource.count({
        where: { ...where, syncStatus: { not: 'synced' } },
      }),
      this.prisma.embedding.count({ where: { resource: { is: where } } }),
    ])

    // Owning lists, batched — one query for the whole page rather than N.
    const items = page.length
      ? await this.prisma.distributionListItem.findMany({
          where: { resourceId: { in: page.map((r) => r.id) } },
          select: {
            resourceId: true,
            distributionList: { select: { id: true, displayName: true } },
          },
        })
      : []
    const listsByResource = new Map<string, { id: string; displayName: string }[]>()
    for (const item of items) {
      if (!item.resourceId) continue
      const bucket = listsByResource.get(item.resourceId) ?? []
      bucket.push(item.distributionList)
      listsByResource.set(item.resourceId, bucket)
    }

    return {
      documents: page.map((r) => ({
        id: r.id,
        filename: r.filename,
        fileType: r.fileType,
        source: r.source,
        sharepointUrl: r.sharepointUrl,
        sharepointCode: r.sharepointCode,
        sharepointVersion: r.sharepointVersion,
        sharepointPendingVersion: r.sharepointPendingVersion,
        syncStatus: r.syncStatus,
        syncError: r.syncError,
        fileDate: r.fileDate,
        lastSyncAttempt: r.lastSyncAttempt,
        chunkCount: r._count.embeddings,
        lists: listsByResource.get(r.id) ?? [],
        updatedAt: r.updatedAt,
      })),
      total,
      pendingTotal,
      chunkTotal,
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    if (!id) throw new BadRequestException('id required')
    try {
      await this.documents.removeDocument(id)
      return { message: 'Document deleted successfully', id }
    } catch {
      throw new BadRequestException('Document not found')
    }
  }

  /**
   * Force the next sync to re-download this file. Clearing `sharepointVersion`
   * defeats the watcher's warm-path skip (which compares stored vs. list Ver);
   * for pasted-link documents the equivalent is clearing the stored eTag,
   * which defeats the refresh pass's change check.
   */
  @Post(':id/resync')
  async resyncOne(@Param('id') id: string) {
    const resource = await this.prisma.resource.findUnique({ where: { id } })
    if (!resource) throw new BadRequestException('Document not found')
    if (resource.source === 'manual-link') {
      const md = (resource.sourceMetadata ?? {}) as Record<string, unknown>
      await this.prisma.resource.update({
        where: { id },
        data: {
          sourceMetadata: { ...md, eTag: '' } as object,
          syncStatus: 'pending_access',
          syncError: null,
        },
      })
      return { message: 'Marked for re-download on the next sync', id }
    }
    if (!resource.sharepointListId) {
      throw new BadRequestException('Only SharePoint-sourced documents can be re-synced')
    }
    await this.prisma.resource.update({
      where: { id },
      data: { sharepointVersion: null, syncStatus: 'pending_access', syncError: null },
    })
    return { message: 'Marked for re-download on the next sync', id }
  }

  /** Full sync across every enabled distribution list, using the admin's token. */
  @Post('sync')
  async syncAll(@Req() req: Request) {
    const session = (req as Request & { session: Session }).session
    const tokenProvider = new DelegatedGraphTokenProvider(session, this.sessions)
    try {
      return await this.watcher.sync(tokenProvider, 'manual')
    } catch (err) {
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
}
