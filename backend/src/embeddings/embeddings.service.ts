import { embed, embedMany } from 'ai'
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { nanoid } from 'nanoid'
import { Prisma } from '@prisma/client'
import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { DocumentInfo, TextChunk } from '../common/types.js'

export interface DocumentDescriptor {
  id: string
  filename: string
  fileType: string
  source: 'upload' | 'sharepoint'
  sharepointUrl?: string
}

export interface SimilaritySearchOptions {
  k?: number
  filenames?: string[]
  maxPerDoc?: number
}

export interface SimilarityHit {
  content: string
  metadata: Record<string, unknown>
}

/**
 * Owns everything that touches the embeddings table. The `halfvec(2048)`
 * column has no Prisma ORM mapping, so vector writes (insert) and reads
 * (KNN search) all go through `$queryRawUnsafe` / `$queryRaw` with the
 * vector cast inline as `::halfvec`.
 */
export class EmbeddingsService {
  private readonly openai: OpenAIProvider

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.openai = createOpenAI({
      baseURL: this.config.openaiApiBase,
      apiKey: this.config.openaiApiKey,
    })
  }

  private async generateEmbedding(text: string): Promise<number[]> {
    const { embedding } = await embed({
      model: this.openai.textEmbeddingModel(this.config.embeddingModel),
      value: text,
    })
    return embedding
  }

  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const { embeddings } = await embedMany({
      model: this.openai.textEmbeddingModel(this.config.embeddingModel),
      values: texts,
    })
    return embeddings
  }

  async addDocument(doc: DocumentDescriptor, chunks: TextChunk[]): Promise<number> {
    const vectors = await this.generateEmbeddings(chunks.map((c) => c.text))

    // Use a single transaction so a half-inserted document never lingers
    // (legacy code did two sequential inserts; FK cascade saved us, but a tx
    // makes the invariant explicit).
    await this.prisma.$transaction(async (tx) => {
      await tx.resource.create({
        data: {
          id: doc.id,
          filename: doc.filename,
          fileType: doc.fileType,
          source: doc.source,
          sharepointUrl: doc.sharepointUrl,
        },
      })

      // Bulk insert via a single VALUES (...) statement. We can't use
      // `tx.embedding.createMany()` because the halfvec column isn't part of
      // the Prisma type — so we hand-build the SQL with one placeholder pair
      // per row and a cast on the embedding placeholder.
      for (let i = 0; i < chunks.length; i++) {
        const id = nanoid()
        const vec = JSON.stringify(vectors[i])
        await tx.$executeRaw`
          INSERT INTO embeddings (id, resource_id, content, embedding, metadata)
          VALUES (${id}, ${doc.id}, ${chunks[i].text}, ${vec}::halfvec, ${chunks[i].metadata}::jsonb)
        `
      }
    })

    return chunks.length
  }

  async deleteDocument(docId: string): Promise<void> {
    // FK is ON DELETE CASCADE, so embeddings go with the resource row.
    await this.prisma.resource.delete({ where: { id: docId } }).catch(() => {})
  }

  async similaritySearch(query: string, opts: SimilaritySearchOptions = {}): Promise<SimilarityHit[]> {
    const { k = 8, filenames, maxPerDoc = 3 } = opts
    try {
      const queryEmbedding = await this.generateEmbedding(query)
      const vec = JSON.stringify(queryEmbedding)
      const filenameClause =
        filenames && filenames.length > 0
          ? Prisma.sql`WHERE r.filename IN (${Prisma.join(filenames)})`
          : Prisma.empty

      type Row = {
        content: string
        metadata: Record<string, unknown> | null
        filename: string
        distance: number
      }
      const rows = await this.prisma.$queryRaw<Row[]>`
        SELECT e.content,
               e.metadata,
               r.filename,
               (e.embedding <=> ${vec}::halfvec)::float AS distance
        FROM embeddings e
        INNER JOIN resources r ON e.resource_id = r.id
        ${filenameClause}
        ORDER BY e.embedding <=> ${vec}::halfvec
        LIMIT ${k * 3}
      `

      // Cap per-document so a single dominant file can't drown out the rest.
      const perDoc = new Map<string, number>()
      const picked: Row[] = []
      for (const r of rows) {
        const n = perDoc.get(r.filename) ?? 0
        if (n >= maxPerDoc) continue
        perDoc.set(r.filename, n + 1)
        picked.push(r)
        if (picked.length >= k) break
      }
      return picked.map((r) => ({
        content: r.content,
        metadata: { ...(r.metadata ?? {}), filename: r.filename },
      }))
    } catch (err) {
      // Match legacy behavior: swallow + log so chat can still respond
      // without RAG context if the vector index is unavailable.
      console.warn('Similarity search failed:', (err as Error).message)
      return []
    }
  }

  async listResourcesWithCounts(): Promise<DocumentInfo[]> {
    type Row = {
      id: string
      filename: string
      file_type: string
      source: string
      sharepoint_url: string | null
      chunk_count: number
    }
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT r.id,
             r.filename,
             r.file_type,
             r.source,
             r.sharepoint_url,
             COUNT(e.id)::int AS chunk_count
      FROM resources r
      LEFT JOIN embeddings e ON e.resource_id = r.id
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      fileType: r.file_type,
      chunkCount: r.chunk_count,
      source: r.source as 'upload' | 'sharepoint',
      sharepointUrl: r.sharepoint_url ?? undefined,
    }))
  }
}
