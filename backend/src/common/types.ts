/**
 * Shared response/request shapes. Public-facing contract — must stay
 * byte-identical with the legacy Hono routes during the cutover.
 */

export interface DocumentInfo {
  id: string
  filename: string
  fileType: string
  chunkCount: number
  source: 'sharepoint' | 'upload' | 'sharepoint-list'
  sharepointUrl?: string
  /**
   * "Open in browser" URL. For sharepoint-list rows this is the original
   * `Link` column value (a DocIdRedir.aspx URL — SharePoint resolves it to
   * the real file using the browser's session cookies). For manually-imported
   * sharepoint rows it's the file's webUrl. Absent for local uploads.
   */
  linkUrl?: string
  /** Only set for sharepoint-list rows. 'synced' for legacy upload/import rows. */
  syncStatus?: 'synced' | 'pending_access' | 'failed_parse' | 'failed_resolve'
  syncError?: string
  /** Source list row identity (sharepoint-list only). */
  sharepointCode?: string
  sharepointVersion?: string
  /**
   * Set when the source list shows a newer Ver than `sharepointVersion`
   * and no caller has been able to resolve it yet. Embeddings still reflect
   * `sharepointVersion`; UI should warn that a fresher copy exists.
   */
  sharepointPendingVersion?: string
  /** Title / Distribution from the source list — handy for display. */
  title?: string
  distribution?: string
}

export interface DocumentListResponse {
  documents: DocumentInfo[]
}

export interface ImportRequest {
  files: SharePointFileRef[]
}

export interface SharePointFileRef {
  siteId?: string
  driveId: string
  itemId: string
  name: string
}

export interface ImportResponse {
  id: string
  filename: string
  chunkCount: number
  message: string
}

export interface SharePointSite {
  id: string
  displayName: string
  webUrl: string
}

export interface SharePointDrive {
  id: string
  name: string
  driveType: string
}

export interface SharePointFile {
  id: string
  name: string
  size: number
  webUrl: string
  lastModifiedDateTime: string
  mimeType?: string
  isFolder?: boolean
  childCount?: number
  driveId?: string
}

export interface ParsedDocument {
  content: string
  metadata: Record<string, string>
}

export interface TextChunk {
  text: string
  metadata: Record<string, string>
}
