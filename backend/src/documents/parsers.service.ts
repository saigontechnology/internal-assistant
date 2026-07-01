import { readFile } from 'node:fs/promises'
import pdf from 'pdf-parse'
import mammoth from 'mammoth'
import { parse as csvParse } from 'csv-parse/sync'
import * as XLSX from 'xlsx'
import { parseOffice, generate as generateOffice } from 'officeparser'
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js'
import type { ParsedDocument } from '../common/types.js'

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.txt', '.md', '.docx', '.csv', '.xlsx',
  '.pptx', '.ppt',
  '.png', '.jpg', '.jpeg',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])

/**
 * Wraps the per-format parsers as injectable methods. Internal implementations
 * are static and pure — DI here exists so tests can swap in a stub parser if
 * needed.
 */
export class ParsersService {
  private ocrWorker: Promise<TesseractWorker> | null = null

  isSupported(filename: string): boolean {
    return SUPPORTED_EXTENSIONS.has(this.getExtension(filename))
  }

  getExtension(filename: string): string {
    const dot = filename.lastIndexOf('.')
    return dot >= 0 ? filename.slice(dot).toLowerCase() : ''
  }

  async parseBuffer(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const ext = this.getExtension(filename)
    switch (ext) {
      case '.pdf':  return this.parsePdf(buffer, filename)
      case '.docx': return this.parseDocx(buffer, filename)
      case '.csv':  return this.parseCsv(buffer, filename)
      case '.xlsx': return this.parseXlsx(buffer, filename)
      case '.pptx':
      case '.ppt':  return this.parsePresentation(buffer, filename, ext)
      case '.png':
      case '.jpg':
      case '.jpeg': return this.parseImage(buffer, filename, ext)
      case '.txt':
      case '.md':   return this.parseText(buffer, filename)
      default:      throw new Error(`Unsupported file type: ${ext}`)
    }
  }

  async dispose(): Promise<void> {
    if (this.ocrWorker) {
      const w = await this.ocrWorker
      await w.terminate().catch(() => {})
      this.ocrWorker = null
    }
  }

  async parseFile(filePath: string): Promise<ParsedDocument> {
    const buffer = await readFile(filePath)
    const filename = filePath.split('/').pop() ?? filePath
    return this.parseBuffer(buffer, filename)
  }

  private async parsePdf(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const data = await pdf(buffer)
    return { content: data.text, metadata: { source: filename, type: 'pdf', pages: String(data.numpages) } }
  }

  private async parseDocx(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const result = await mammoth.extractRawText({ buffer })
    return { content: result.value, metadata: { source: filename, type: 'docx' } }
  }

  private parseCsv(buffer: Buffer, filename: string): ParsedDocument {
    const text = buffer.toString('utf-8')
    const records = csvParse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[]
    const content = records
      .map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', '))
      .join('\n')
    return { content, metadata: { source: filename, type: 'csv', rows: String(records.length) } }
  }

  private parseXlsx(buffer: Buffer, filename: string): ParsedDocument {
    const workbook = XLSX.read(buffer, { type: 'buffer' })
    const parts: string[] = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) continue
      parts.push(`--- Sheet: ${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}`)
    }
    return {
      content: parts.join('\n\n'),
      metadata: { source: filename, type: 'xlsx', sheets: String(workbook.SheetNames.length) },
    }
  }

  private async parsePresentation(
    buffer: Buffer,
    filename: string,
    ext: string,
  ): Promise<ParsedDocument> {
    // officeparser supports .pptx natively (XML-based). Legacy .ppt (binary
    // OLE) is not supported by any pure-JS lib; we attempt anyway and surface
    // a clear error so the caller can mark the row failed.
    try {
      const ast = await parseOffice(buffer, { fileType: 'pptx' })
      const result = await generateOffice(ast, 'text', {})
      const text = typeof result.value === 'string' ? result.value : String(result.value ?? '')
      return {
        content: text,
        metadata: { source: filename, type: ext === '.pptx' ? 'pptx' : 'ppt' },
      }
    } catch (err) {
      if (ext === '.ppt') {
        throw new Error(
          `Legacy .ppt (binary) is not supported — re-save as .pptx. (${(err as Error).message})`,
        )
      }
      throw err
    }
  }

  private async parseImage(
    buffer: Buffer,
    filename: string,
    ext: string,
  ): Promise<ParsedDocument> {
    const worker = await this.getOcrWorker()
    const { data } = await worker.recognize(buffer)
    const text = (data?.text ?? '').trim()
    return {
      content: text,
      metadata: {
        source: filename,
        type: ext.slice(1),
        ocr: 'tesseract',
        ocr_lang: 'eng',
        ocr_confidence: data?.confidence != null ? String(data.confidence) : '',
      },
    }
  }

  private getOcrWorker(): Promise<TesseractWorker> {
    if (!this.ocrWorker) {
      this.ocrWorker = createWorker('eng')
    }
    return this.ocrWorker
  }

  private parseText(buffer: Buffer, filename: string): ParsedDocument {
    return {
      content: buffer.toString('utf-8'),
      metadata: { source: filename, type: filename.endsWith('.md') ? 'markdown' : 'text' },
    }
  }
}
