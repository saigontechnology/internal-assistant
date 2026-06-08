import { readFile } from "node:fs/promises";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import type { ParsedDocument } from "../types.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".pdf",
  ".txt",
  ".md",
  ".docx",
  ".csv",
  ".xlsx",
]);

export function isSupportedFile(filename: string): boolean {
  const ext = getExtension(filename);
  return SUPPORTED_EXTENSIONS.has(ext);
}

export function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export async function parseBuffer(
  buffer: Buffer,
  filename: string
): Promise<ParsedDocument> {
  const ext = getExtension(filename);

  switch (ext) {
    case ".pdf":
      return parsePdf(buffer, filename);
    case ".docx":
      return parseDocx(buffer, filename);
    case ".csv":
      return parseCsv(buffer, filename);
    case ".xlsx":
      return parseXlsx(buffer, filename);
    case ".txt":
    case ".md":
      return parseText(buffer, filename);
    default:
      throw new Error(`Unsupported file type: ${ext}`);
  }
}

async function parsePdf(
  buffer: Buffer,
  filename: string
): Promise<ParsedDocument> {
  const data = await pdf(buffer);
  return {
    content: data.text,
    metadata: { source: filename, type: "pdf", pages: String(data.numpages) },
  };
}

async function parseDocx(
  buffer: Buffer,
  filename: string
): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  return {
    content: result.value,
    metadata: { source: filename, type: "docx" },
  };
}

function parseCsv(buffer: Buffer, filename: string): ParsedDocument {
  const text = buffer.toString("utf-8");
  const records = csvParse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const content = records
    .map((row) =>
      Object.entries(row)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")
    )
    .join("\n");

  return {
    content,
    metadata: { source: filename, type: "csv", rows: String(records.length) },
  };
}

function parseXlsx(buffer: Buffer, filename: string): ParsedDocument {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet);
    parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }

  return {
    content: parts.join("\n\n"),
    metadata: {
      source: filename,
      type: "xlsx",
      sheets: String(workbook.SheetNames.length),
    },
  };
}

function parseText(buffer: Buffer, filename: string): ParsedDocument {
  return {
    content: buffer.toString("utf-8"),
    metadata: {
      source: filename,
      type: filename.endsWith(".md") ? "markdown" : "text",
    },
  };
}

export async function parseFile(filePath: string): Promise<ParsedDocument> {
  const buffer = await readFile(filePath);
  const filename = filePath.split("/").pop() ?? filePath;
  return parseBuffer(buffer, filename);
}
