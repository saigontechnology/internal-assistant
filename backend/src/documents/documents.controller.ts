import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
// Pulls the Express.Multer.File ambient type into scope.
import 'multer'
import type { Request, Response } from 'express'
import type { Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import { ViewerAccessService } from '../access/viewer-access.service.js'
import { DocumentsService } from './documents.service.js'
import { SharepointService } from '../sharepoint/sharepoint.service.js'
import type { ImportRequest } from '../common/types.js'

/**
 * `/api/documents/*`. Every route goes through the global SessionGuard;
 * mutations additionally require an admin. The `/upload` endpoint reads the
 * multipart body via FileInterceptor (multer under the hood).
 *
 * These paths used to be `@Public()` to match the legacy Hono contract. They
 * are now authenticated — the frontend already called them from an authed
 * session, so only out-of-band consumers are affected.
 */
@Controller('documents')
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(SharepointService) private readonly sharepoint: SharepointService,
    @Inject(ViewerAccessService) private readonly viewer: ViewerAccessService,
  ) {}

  /**
   * Any signed-in user. Results are filtered to the caller's job-profile
   * allow-list (public/NULL-code docs plus whatever their profile grants) so
   * the inventory never leaks the existence, titles, or SharePoint links of
   * documents outside the caller's access scope.
   */
  @Get('/')
  async list(@Req() req: Request) {
    const session = (req as Request & { session: Session }).session
    const access = await this.viewer.resolve(session)
    const documents = await this.documents.listDocuments({
      viewer: access.publicOnly ? undefined : access.viewer,
      publicOnly: access.publicOnly,
    })
    return { documents }
  }

  @Post('upload')
  @UseGuards(AdminGuard)
  // Cap the in-memory upload: multer's default memory storage buffers the whole
  // file, so an unbounded upload can exhaust the process heap. 50 MB covers the
  // largest real documents (scanned PDFs) with margin.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024, files: 1 } }))
  async upload(@UploadedFile() file: Express.Multer.File | undefined, @Res() res: Response) {
    if (!file) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'No file provided' })
      return
    }
    try {
      const result = await this.documents.uploadLocalFile(file.buffer, file.originalname)
      res.json(result)
    } catch (err) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: err instanceof Error ? err.message : 'Upload failed',
      })
    }
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  async import(@Req() req: Request, @Res() res: Response) {
    const body = req.body as ImportRequest
    if (!body?.files?.length) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: 'No files specified' })
      return
    }
    const session = (req as Request & { session: Session }).session
    const accessToken = await this.sharepoint.tokenFor(session)

    const results = []
    const errors: { file: string; error: string }[] = []
    for (const fileRef of body.files) {
      try {
        results.push(await this.documents.importFromSharePoint(accessToken, fileRef))
      } catch (err) {
        errors.push({
          file: fileRef.name || fileRef.itemId,
          error: err instanceof Error ? err.message : 'Import failed',
        })
      }
    }
    // 207 Multi-Status when any per-file error occurred, matching legacy contract.
    res.status(errors.length > 0 ? 207 : 200).json({ imported: results, errors })
  }

  @Delete(':docId')
  @UseGuards(AdminGuard)
  async remove(@Param('docId') docId: string) {
    if (!docId) throw new BadRequestException('docId required')
    try {
      await this.documents.removeDocument(docId)
      return { message: 'Document deleted successfully', id: docId }
    } catch {
      throw new BadRequestException('Document not found')
    }
  }
}
