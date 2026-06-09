import { randomUUID } from 'node:crypto'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { ParsersService } from './parsers.service.js'
import { SharepointService } from '../sharepoint/sharepoint.service.js'
import { splitText } from './text-splitter.js'
import type { DocumentInfo, ImportResponse, SharePointFileRef } from '../common/types.js'

function getFileType(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : 'unknown'
}

/**
 * Orchestrates the upload / import / list / delete flows. Delegates parsing,
 * chunking, embedding, and SharePoint I/O to the other services.
 */
export class DocumentsService {
  constructor(
    private readonly config: AppConfig,
    private readonly parsers: ParsersService,
    private readonly embeddings: EmbeddingsService,
    private readonly sharepoint: SharepointService,
  ) {}

  async uploadLocalFile(buffer: Buffer, filename: string): Promise<ImportResponse> {
    if (!this.parsers.isSupported(filename)) {
      throw new Error(`Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX`)
    }
    const parsed = await this.parsers.parseBuffer(buffer, filename)
    const chunks = splitText(parsed.content, parsed.metadata, this.config.chunkSize, this.config.chunkOverlap)
    const docId = randomUUID().replace(/-/g, '').slice(0, 12)
    const chunkCount = await this.embeddings.addDocument(
      { id: docId, filename, fileType: getFileType(filename), source: 'upload' },
      chunks,
    )
    return { id: docId, filename, chunkCount, message: 'Document uploaded and indexed successfully' }
  }

  async importFromSharePoint(accessToken: string, fileRef: SharePointFileRef): Promise<ImportResponse> {
    const filename =
      fileRef.name || (await this.sharepoint.getFileName(accessToken, fileRef.driveId, fileRef.itemId))

    if (!this.parsers.isSupported(filename)) {
      throw new Error(`Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX`)
    }

    const buffer = await this.sharepoint.downloadFile(accessToken, fileRef.driveId, fileRef.itemId)
    const parsed = await this.parsers.parseBuffer(buffer, filename)
    const chunks = splitText(
      parsed.content,
      { ...parsed.metadata, sharepoint_item_id: fileRef.itemId },
      this.config.chunkSize,
      this.config.chunkOverlap,
    )
    const docId = randomUUID().replace(/-/g, '').slice(0, 12)
    const chunkCount = await this.embeddings.addDocument(
      {
        id: docId,
        filename,
        fileType: getFileType(filename),
        source: 'sharepoint',
        sharepointUrl: parsed.metadata.sharepoint_url,
      },
      chunks,
    )
    return { id: docId, filename, chunkCount, message: 'Document imported and indexed successfully' }
  }

  async listDocuments(): Promise<DocumentInfo[]> {
    return this.embeddings.listResourcesWithCounts()
  }

  async removeDocument(docId: string): Promise<void> {
    await this.embeddings.deleteDocument(docId)
  }
}
