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
  ) {}

  /** Any signed-in user. Results are job-profile filtered downstream. */
  @Get('/')
  async list() {
    const documents = await this.documents.listDocuments()
    return { documents }
  }

  @Post('upload')
  @UseGuards(AdminGuard)
  @UseInterceptors(FileInterceptor('file'))
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
