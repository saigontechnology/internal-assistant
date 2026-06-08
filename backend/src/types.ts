export interface DocumentInfo {
  id: string;
  filename: string;
  fileType: string;
  chunkCount: number;
  source: "sharepoint" | "upload";
  sharepointUrl?: string;
}

export interface DocumentListResponse {
  documents: DocumentInfo[];
}

export interface ImportRequest {
  files: SharePointFileRef[];
}

export interface SharePointFileRef {
  siteId?: string;
  driveId: string;
  itemId: string;
  name: string;
}

export interface ImportResponse {
  id: string;
  filename: string;
  chunkCount: number;
  message: string;
}

export interface SharePointSite {
  id: string;
  displayName: string;
  webUrl: string;
}

export interface SharePointDrive {
  id: string;
  name: string;
  driveType: string;
}

export interface SharePointFile {
  id: string;
  name: string;
  size: number;
  webUrl: string;
  lastModifiedDateTime: string;
  mimeType?: string;
  isFolder?: boolean;
  childCount?: number;
  driveId?: string;
}

export interface ParsedDocument {
  content: string;
  metadata: Record<string, string>;
}

export interface TextChunk {
  text: string;
  metadata: Record<string, string>;
}
