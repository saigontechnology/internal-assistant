import { randomUUID } from "node:crypto";
import { parseBuffer, isSupportedFile } from "../lib/parsers.js";
import { splitText } from "../lib/text-splitter.js";
import { config } from "../config.js";
import {
  addDocuments,
  deleteDocuments,
  listResourcesWithCounts,
} from "./embedding-service.js";
import {
  downloadFile,
  getFileName,
} from "./sharepoint-service.js";
import type { DocumentInfo, SharePointFileRef, ImportResponse } from "../types.js";

function getFileType(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "unknown";
}

export async function uploadLocalFile(
  buffer: Buffer,
  filename: string
): Promise<ImportResponse> {
  if (!isSupportedFile(filename)) {
    throw new Error(
      `Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX`
    );
  }

  const parsed = await parseBuffer(buffer, filename);
  const chunks = splitText(
    parsed.content,
    parsed.metadata,
    config.chunkSize,
    config.chunkOverlap
  );

  const docId = randomUUID().replace(/-/g, "").slice(0, 12);
  const chunkCount = await addDocuments(
    {
      id: docId,
      filename,
      fileType: getFileType(filename),
      source: "upload",
    },
    chunks
  );

  return {
    id: docId,
    filename,
    chunkCount,
    message: "Document uploaded and indexed successfully",
  };
}

export async function importFromSharePoint(
  accessToken: string,
  fileRef: SharePointFileRef
): Promise<ImportResponse> {
  const filename =
    fileRef.name || (await getFileName(accessToken, fileRef.driveId, fileRef.itemId));

  if (!isSupportedFile(filename)) {
    throw new Error(
      `Unsupported file type: ${filename}. Supported: PDF, TXT, MD, DOCX, CSV, XLSX`
    );
  }

  const buffer = await downloadFile(accessToken, fileRef.driveId, fileRef.itemId);

  const parsed = await parseBuffer(buffer, filename);
  const chunks = splitText(
    parsed.content,
    { ...parsed.metadata, sharepoint_item_id: fileRef.itemId },
    config.chunkSize,
    config.chunkOverlap
  );

  const docId = randomUUID().replace(/-/g, "").slice(0, 12);
  const chunkCount = await addDocuments(
    {
      id: docId,
      filename,
      fileType: getFileType(filename),
      source: "sharepoint",
      sharepointUrl: parsed.metadata.sharepoint_url,
    },
    chunks
  );

  return {
    id: docId,
    filename,
    chunkCount,
    message: "Document imported and indexed successfully",
  };
}

export async function listDocuments(): Promise<DocumentInfo[]> {
  return listResourcesWithCounts();
}

export async function removeDocument(docId: string): Promise<void> {
  await deleteDocuments(docId);
}
