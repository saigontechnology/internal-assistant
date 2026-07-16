import { randomUUID } from 'node:crypto'
import { nanoid } from 'nanoid'
import { embedMany } from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { EmbeddingsService, type ViewerProfile } from '../embeddings/embeddings.service.js'
import { ParsersService } from './parsers.service.js'
import { fileDateFromSourceMetadata } from './parse-file-date.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { SharepointService } from '../sharepoint/sharepoint.service.js'
import { splitText } from './text-splitter.js'
import type { DocumentInfo, ImportResponse, SharePointFileRef } from '../common/types.js'

function getFileType(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : 'unknown'
}

/**
 * One-line label prepended to every chunk before embedding. Keeps a
 * mid-document chunk self-describing — the embedding picks up the doc's
 * identity, and a retrieved chunk shown to the LLM already announces what it
 * came from. Keep this short (<= ~100 chars) so it doesn't dominate small
 * chunks.
 */
function buildChunkHeader(parts: {
  filename: string
  fileType: string
  title?: string
  code?: string
}): string {
  const bits = [`Document: ${parts.filename}`]
  if (parts.title && parts.title !== parts.filename) bits.push(`Title: ${parts.title}`)
  if (parts.code) bits.push(`Code: ${parts.code}`)
  bits.push(`Type: ${parts.fileType}`)
  return `[${bits.join(' | ')}]`
}

/** Outcome reported back to the watcher for counter bookkeeping. */
export type SharepointUpsertOutcome =
  | { kind: 'ingested'; chunkCount: number }   // new SP row, file ingested
  | { kind: 'updated'; chunkCount: number }    // ver bumped or status changed → re-embedded
  | { kind: 'skipped' }                        // same code+ver, already synced
  | { kind: 'pending' }                        // metadata recorded, no file
  | { kind: 'failed' }                         // metadata recorded with sync_error

export interface SharepointUpsertArgs {
  listId: string
  code: string
  version: string
  title: string
  sourceMetadata: Record<string, unknown>
  /** Provide when the file was resolved + downloaded. Triggers re-embed if ver changed. */
  file?: { buffer: Buffer; filename: string }
  /** Reason status isn't 'synced' — recorded for ops. Ignored when `file` is provided. */
  status?: 'pending_access' | 'failed_parse' | 'failed_resolve'
  error?: string
}

/**
 * Orchestrates the upload / import / list / delete flows. Delegates parsing,
 * chunking, embedding, and SharePoint I/O to the other services.
 */
export class DocumentsService {
  private readonly openai: OpenAIProvider

  constructor(
    private readonly config: AppConfig,
    private readonly parsers: ParsersService,
    private readonly embeddings: EmbeddingsService,
    private readonly sharepoint: SharepointService,
    private readonly prisma: PrismaService,
    private readonly settings: RuntimeSettingsService,
  ) {
    this.openai = buildOpenAIClient(config)
  }

  async uploadLocalFile(buffer: Buffer, filename: string): Promise<ImportResponse> {
    if (!this.parsers.isSupported(filename)) {
      throw new Error(`Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX, PPTX, PPT, PNG, JPG, JPEG`)
    }
    const parsed = await this.parsers.parseBuffer(buffer, filename)
    const fileType = getFileType(filename)
    const chunks = splitText(
      parsed.content,
      parsed.metadata,
      this.settings.chunkSize,
      this.settings.chunkOverlap,
      buildChunkHeader({ filename, fileType }),
    )
    const docId = randomUUID().replace(/-/g, '').slice(0, 12)
    const chunkCount = await this.embeddings.addDocument(
      { id: docId, filename, fileType, source: 'upload' },
      chunks,
    )
    return { id: docId, filename, chunkCount, message: 'Document uploaded and indexed successfully' }
  }

  async importFromSharePoint(accessToken: string, fileRef: SharePointFileRef): Promise<ImportResponse> {
    const filename =
      fileRef.name || (await this.sharepoint.getFileName(accessToken, fileRef.driveId, fileRef.itemId))

    if (!this.parsers.isSupported(filename)) {
      throw new Error(`Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX, PPTX, PPT, PNG, JPG, JPEG`)
    }

    const buffer = await this.sharepoint.downloadFile(accessToken, fileRef.driveId, fileRef.itemId)
    const parsed = await this.parsers.parseBuffer(buffer, filename)
    const fileType = getFileType(filename)
    const chunks = splitText(
      parsed.content,
      { ...parsed.metadata, sharepoint_item_id: fileRef.itemId },
      this.settings.chunkSize,
      this.settings.chunkOverlap,
      buildChunkHeader({ filename, fileType }),
    )
    const docId = randomUUID().replace(/-/g, '').slice(0, 12)
    const chunkCount = await this.embeddings.addDocument(
      {
        id: docId,
        filename,
        fileType,
        source: 'sharepoint',
        sharepointUrl: parsed.metadata.sharepoint_url,
      },
      chunks,
    )
    return { id: docId, filename, chunkCount, message: 'Document imported and indexed successfully' }
  }

  /**
   * Import one pasted SharePoint file URL. The resulting resource is PUBLIC —
   * `sharepointCode` stays NULL, which every access predicate treats as
   * "visible to all viewers". Identity for dedup/refresh is the Graph
   * `(driveId, itemId)` pair kept in `sourceMetadata`, so pasting the same
   * file again (even via a different link form) updates in place.
   */
  async importFromLink(
    accessToken: string,
    rawLink: string,
    addedBy: string | null,
  ): Promise<ImportResponse> {
    const link = rawLink.trim()
    const item = await this.sharepoint.resolveShareUrl(accessToken, link)
    if (item.isFolder) {
      throw new Error('Link points to a folder — paste links to individual files')
    }
    if (!this.parsers.isSupported(item.name)) {
      throw new Error(`Unsupported file type: ${item.name}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX, PPTX, PPT, PNG, JPG, JPEG`)
    }

    const existing = await this.findManualLink(item.driveId, item.itemId)
    if (existing && existing.syncStatus === 'synced') {
      const md = (existing.sourceMetadata ?? {}) as Record<string, unknown>
      if (item.eTag && md.eTag === item.eTag) {
        const chunkCount = await this.prisma.embedding.count({
          where: { resourceId: existing.id },
        })
        return {
          id: existing.id,
          filename: existing.filename,
          chunkCount,
          message: 'Already indexed and up to date',
        }
      }
    }

    const result = await this.ingestManualLink({
      accessToken,
      driveId: item.driveId,
      itemId: item.itemId,
      name: item.name,
      webUrl: item.webUrl,
      eTag: item.eTag,
      lastModifiedDateTime: item.lastModifiedDateTime,
      link,
      addedBy,
      replaceId: existing?.id,
    })
    return {
      id: result.id,
      filename: item.name,
      chunkCount: result.chunkCount,
      message: existing
        ? 'Document re-indexed from the latest version'
        : 'Document imported and indexed successfully',
    }
  }

  /**
   * Refresh pass over every manual-link resource, run at the tail of a watcher
   * sync. Metadata-only probe first; only changed files are re-downloaded and
   * re-embedded. A Graph failure (403/404 covers both "deleted" and "the
   * syncing user can't see it") keeps the existing content and records the
   * error — a working document must never vanish because the wrong person
   * pressed Sync.
   */
  async refreshManualLinks(
    tokens: { getToken(): Promise<string> },
  ): Promise<{ checked: number; refreshed: number; failed: number }> {
    const rows = await this.prisma.resource.findMany({
      where: { source: 'manual-link' },
      orderBy: { createdAt: 'asc' },
    })
    let refreshed = 0
    let failed = 0
    for (const row of rows) {
      const now = new Date()
      const md = (row.sourceMetadata ?? {}) as Record<string, unknown>
      const driveId = typeof md.driveId === 'string' ? md.driveId : ''
      const itemId = typeof md.itemId === 'string' ? md.itemId : ''
      try {
        if (!driveId || !itemId) {
          throw new Error('missing driveId/itemId in source metadata')
        }
        const token = await tokens.getToken()
        const meta = await this.sharepoint.getItemMeta(token, driveId, itemId)
        if (row.syncStatus === 'synced' && meta.eTag && meta.eTag === md.eTag) {
          await this.prisma.resource.update({
            where: { id: row.id },
            data: { lastSyncAttempt: now, syncError: null },
          })
          continue
        }
        await this.ingestManualLink({
          accessToken: token,
          driveId,
          itemId,
          name: meta.name,
          webUrl: meta.webUrl,
          eTag: meta.eTag,
          lastModifiedDateTime: meta.lastModifiedDateTime,
          link: typeof md.link === 'string' ? md.link : (row.sharepointUrl ?? ''),
          addedBy: typeof md.addedBy === 'string' ? md.addedBy : null,
          replaceId: row.id,
        })
        refreshed++
      } catch (err) {
        failed++
        await this.prisma.resource
          .update({
            where: { id: row.id },
            data: {
              syncError: err instanceof Error ? err.message : String(err),
              lastSyncAttempt: now,
            },
          })
          .catch(() => {})
      }
    }
    return { checked: rows.length, refreshed, failed }
  }

  /** Manual-link identity lookup: `(driveId, itemId)` inside `sourceMetadata`. */
  private async findManualLink(driveId: string, itemId: string) {
    return this.prisma.resource.findFirst({
      where: {
        source: 'manual-link',
        AND: [
          { sourceMetadata: { path: ['driveId'], equals: driveId } },
          { sourceMetadata: { path: ['itemId'], equals: itemId } },
        ],
      },
    })
  }

  /** Download + parse + embed one manual-link file; atomically replaces `replaceId` if given. */
  private async ingestManualLink(args: {
    accessToken: string
    driveId: string
    itemId: string
    name: string
    webUrl: string
    eTag: string
    lastModifiedDateTime: string
    link: string
    addedBy: string | null
    replaceId?: string
  }): Promise<{ id: string; chunkCount: number }> {
    if (!this.parsers.isSupported(args.name)) {
      throw new Error(`Unsupported file type: ${args.name}`)
    }
    const buffer = await this.sharepoint.downloadFile(args.accessToken, args.driveId, args.itemId)
    const parsed = await this.parsers.parseBuffer(buffer, args.name)
    const fileType = getFileType(args.name)
    const chunks = splitText(
      parsed.content,
      { ...parsed.metadata, sharepoint_item_id: args.itemId },
      this.settings.chunkSize,
      this.settings.chunkOverlap,
      buildChunkHeader({ filename: args.name, fileType }),
    )
    const docId = randomUUID().replace(/-/g, '').slice(0, 12)
    const chunkCount = await this.embeddings.addDocument(
      {
        id: docId,
        filename: args.name,
        fileType,
        source: 'manual-link',
        sharepointUrl: args.webUrl,
        sourceMetadata: {
          link: args.link,
          driveId: args.driveId,
          itemId: args.itemId,
          eTag: args.eTag,
          lastModifiedDateTime: args.lastModifiedDateTime,
          addedBy: args.addedBy,
        },
        lastSyncAttempt: new Date(),
      },
      chunks,
      args.replaceId,
    )
    return { id: docId, chunkCount }
  }

  async listDocuments(
    opts: { viewer?: ViewerProfile; publicOnly?: boolean } = {},
  ): Promise<DocumentInfo[]> {
    return this.embeddings.listResourcesWithCounts(opts)
  }

  async removeDocument(docId: string): Promise<void> {
    await this.embeddings.deleteDocument(docId)
  }

  // ── SharePoint-list watcher entry point ────────────────────────────

  /** @deprecated unused — watcher now pre-fetches DB state at sync start. */
  async isAlreadySyncedAtVersion(
    listId: string,
    code: string,
    version: string,
  ): Promise<boolean> {
    const existing = await this.prisma.resource.findUnique({
      where: { sp_code_uk: { sharepointListId: listId, sharepointCode: code } },
      select: {
        id: true,
        sharepointVersion: true,
        sharepointPendingVersion: true,
        syncStatus: true,
      },
    })
    if (
      !existing ||
      existing.syncStatus !== 'synced' ||
      existing.sharepointVersion !== version
    ) {
      return false
    }
    await this.prisma.resource.update({
      where: { id: existing.id },
      data: {
        lastSyncAttempt: new Date(),
        sharepointPendingVersion:
          existing.sharepointPendingVersion !== null ? null : undefined,
      },
    })
    return true
  }


  /**
   * Atomic per-row upsert used by the list watcher. Handles four cases in
   * one call so the watcher's main loop stays linear:
   *
   *   1. Same (list_id, code, version) already 'synced' → no-op, return 'skipped'.
   *   2. File provided → re-embed: delete existing (if any) + insert resource +
   *      insert N embedding rows, all in one $transaction.
   *   3. No file + status='pending_access' → upsert resource metadata only.
   *      Embeddings absent; ready for Phase B to fill in.
   *   4. No file + status='failed_*' → upsert resource metadata with sync_error.
   *
   * Cases 3/4 still write a `resources` row so the inventory is complete
   * regardless of access — see docs/sharepoint-list-watcher-plan.md §1.
   */
  async upsertFromSharepointList(args: SharepointUpsertArgs): Promise<SharepointUpsertOutcome> {
    const now = new Date()
    const fileDate = fileDateFromSourceMetadata(args.sourceMetadata)
    const existing = await this.prisma.resource.findUnique({
      where: { sp_code_uk: { sharepointListId: args.listId, sharepointCode: args.code } },
      select: {
        id: true,
        sharepointVersion: true,
        sharepointPendingVersion: true,
        syncStatus: true,
      },
    })

    // Case 1: nothing to do.
    if (
      existing &&
      args.file &&
      existing.sharepointVersion === args.version &&
      existing.syncStatus === 'synced'
    ) {
      return { kind: 'skipped' }
    }

    // Cases 3/4: metadata-only upsert — no file, no embeddings.
    if (!args.file) {
      const status = args.status ?? 'pending_access'

      // Never downgrade a row that some other caller already synced.
      // Strategy H is per-user, so a user without access to this file would
      // otherwise wipe a previously-ingested resource's embeddings on every
      // sync. Keep what's there; let a future call from someone with access
      // refresh it. If the source list shows a newer Ver than what we have,
      // record it on `sharepoint_pending_version` so the UI can warn that
      // embeddings are stale.
      if (existing && existing.syncStatus === 'synced') {
        const pendingVersion =
          existing.sharepointVersion !== args.version ? args.version : null
        await this.prisma.resource.update({
          where: { id: existing.id },
          data: {
            lastSyncAttempt: now,
            sharepointPendingVersion: pendingVersion,
          },
        })
        return { kind: 'skipped' }
      }

      if (
        existing &&
        existing.sharepointVersion === args.version &&
        existing.syncStatus === status
      ) {
        // status & version unchanged; just bump last_sync_attempt
        await this.prisma.resource.update({
          where: { id: existing.id },
          data: { lastSyncAttempt: now },
        })
        return { kind: 'skipped' }
      }

      if (existing) {
        // Status/version changed (e.g. user lost access, or ver bumped but file
        // not resolvable yet). Drop any embedding rows; switch resource to
        // metadata-only state.
        await this.prisma.$transaction([
          this.prisma.embedding.deleteMany({ where: { resourceId: existing.id } }),
          this.prisma.resource.update({
            where: { id: existing.id },
            data: {
              sharepointVersion: args.version,
              sourceMetadata: args.sourceMetadata as object,
              fileDate,
              syncStatus: status,
              syncError: args.error ?? null,
              lastSyncAttempt: now,
            },
          }),
        ])
      } else {
        await this.prisma.resource.create({
          data: {
            id: nanoid(12),
            filename: `${args.code} (pending)`,
            fileType: 'unknown',
            source: 'sharepoint-list',
            sharepointListId: args.listId,
            sharepointCode: args.code,
            sharepointVersion: args.version,
            sourceMetadata: args.sourceMetadata as object,
            fileDate,
            syncStatus: status,
            syncError: args.error ?? null,
            lastSyncAttempt: now,
          },
        })
      }
      return { kind: status === 'pending_access' ? 'pending' : 'failed' }
    }

    // Case 2: file provided. Parse → chunk → embed → atomic replace.
    if (!this.parsers.isSupported(args.file.filename)) {
      // Still record the row so it's not invisible — counts as failed_parse.
      return this.upsertFromSharepointList({
        ...args,
        file: undefined,
        status: 'failed_parse',
        error: `Unsupported file type: ${args.file.filename}`,
      })
    }

    const parsed = await this.parsers.parseBuffer(args.file.buffer, args.file.filename)
    const fileType = getFileType(args.file.filename)
    const md = args.sourceMetadata as Record<string, unknown>
    const chunks = splitText(
      { ...parsed }.content,
      {
        ...parsed.metadata,
        sharepoint_list_id: args.listId,
        sharepoint_code: args.code,
        sharepoint_version: args.version,
      },
      this.settings.chunkSize,
      this.settings.chunkOverlap,
      buildChunkHeader({
        filename: args.file.filename,
        fileType,
        title: typeof md.title === 'string' ? md.title : args.title,
        code: args.code,
      }),
    )

    // Generate embeddings BEFORE opening the transaction so the tx is short.
    const { embeddings: vectors } = await embedMany({
      model: this.openai.textEmbeddingModel(this.config.embeddingModel),
      values: chunks.map((c) => c.text),
    })

    const newResourceId = nanoid(12)
    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        // Delete the old row; FK cascade clears its embeddings.
        await tx.resource.delete({ where: { id: existing.id } })
      }
      await tx.resource.create({
        data: {
          id: newResourceId,
          filename: args.file!.filename,
          fileType,
          source: 'sharepoint-list',
          sharepointListId: args.listId,
          sharepointCode: args.code,
          sharepointVersion: args.version,
          sourceMetadata: args.sourceMetadata as object,
          fileDate,
          syncStatus: 'synced',
          syncError: null,
          lastSyncAttempt: now,
        },
      })
      // Bulk-insert embeddings — raw SQL because halfvec isn't a Prisma type.
      for (let i = 0; i < chunks.length; i++) {
        const id = nanoid()
        const vec = JSON.stringify(vectors[i])
        await tx.$executeRaw`
          INSERT INTO embeddings (id, resource_id, content, embedding, metadata)
          VALUES (${id}, ${newResourceId}, ${chunks[i].text}, ${vec}::halfvec, ${chunks[i].metadata}::jsonb)
        `
      }
    })

    return { kind: existing ? 'updated' : 'ingested', chunkCount: chunks.length }
  }

  /**
   * Demote rows whose `sharepointListId` is not in the discovered set to
   * `pending_access`. The list may have been deleted, renamed, or the current
   * caller may simply have lost access; in any case its rows should disappear
   * from search until the list returns. Embeddings are left in place so a
   * recovery sync doesn't have to re-embed everything from scratch.
   *
   * Returns the count of demoted rows.
   */
  async demoteOrphanedSharepointRows(discoveredListIds: Set<string>): Promise<number> {
    const live = Array.from(discoveredListIds)
    const result = await this.prisma.resource.updateMany({
      where: {
        source: 'sharepoint-list',
        syncStatus: 'synced',
        sharepointListId: live.length > 0 ? { notIn: live } : { not: null },
      },
      data: {
        syncStatus: 'pending_access',
        syncError: 'list disappeared from discovery',
        lastSyncAttempt: new Date(),
      },
    })
    return result.count
  }

  /** Remove all SP-sourced resources whose `code` isn't in the given set. */
  async removeStaleSharepointRows(listId: string, liveCodes: Set<string>): Promise<number> {
    const live = Array.from(liveCodes)
    // Build a list of all SP-sourced rows for this list, then delete the ones not in `live`.
    const existing = await this.prisma.resource.findMany({
      where: { sharepointListId: listId },
      select: { id: true, sharepointCode: true },
    })
    const stale = existing.filter((r) => r.sharepointCode && !liveCodes.has(r.sharepointCode))
    if (stale.length === 0) return 0
    await this.prisma.resource.deleteMany({ where: { id: { in: stale.map((r) => r.id) } } })
    return stale.length
  }
}
