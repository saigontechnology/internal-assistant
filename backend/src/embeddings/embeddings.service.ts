import { embed, embedMany } from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { nanoid } from 'nanoid'
import { Prisma } from '@prisma/client'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import type { DocumentInfo, TextChunk } from '../common/types.js'

export interface DocumentDescriptor {
  id: string
  filename: string
  fileType: string
  source: 'upload' | 'sharepoint'
  sharepointUrl?: string
}

export interface ViewerProfile {
  jobTitle: string
  department: string
}

export interface SimilaritySearchOptions {
  k?: number
  filenames?: string[]
  maxPerDoc?: number
  /**
   * When set, restricts results to docs where `sharepoint_code IS NULL` (public)
   * OR the (viewer.jobTitle, viewer.department) tuple has an entry for the doc's
   * code in `job_profile_access`. Omit for admin/unfiltered queries.
   */
  viewer?: ViewerProfile
  /**
   * When `viewer` is omitted AND this is true, restrict to public docs only.
   * Used by the chat layer for the "neither user profile nor fallback profile
   * is indexed yet" cold-start case.
   */
  publicOnly?: boolean
}

export interface SimilarityHit {
  content: string
  metadata: Record<string, unknown>
}

export interface SimilaritySearchResult {
  hits: SimilarityHit[]
  /**
   * Number of distinct resources that ranked in the top semantic candidates
   * for this query but were excluded by access control. Never surfaces any
   * identifying detail (filenames/codes/titles) about the restricted docs —
   * just the count, so the chat layer can tell the user "you don't have
   * permission" without leaking what exists.
   *
   * Always 0 when access control is disabled (no viewer + !publicOnly).
   */
  restrictedCount: number
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
    this.openai = buildOpenAIClient(this.config)
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

  async similaritySearch(query: string, opts: SimilaritySearchOptions = {}): Promise<SimilaritySearchResult> {
    const { k = 8, filenames, maxPerDoc = 3, viewer, publicOnly } = opts
    try {
      const queryEmbedding = await this.generateEmbedding(query)
      const vec = JSON.stringify(queryEmbedding)
      // Filter is shared between the vector and FTS legs of the hybrid query;
      // expressed as an AND-clause so we can join it onto the always-true
      // `WHERE 1=1` baseline without branching SQL shape.
      const filenameAnd =
        filenames && filenames.length > 0
          ? Prisma.sql`AND r.filename IN (${Prisma.join(filenames)})`
          : Prisma.empty
      // Access-control filter. `viewer` opens up the job_profile_access
      // allow-list for that tuple; `publicOnly` restricts to docs with NULL
      // sharepoint_code; omitting both is admin-mode (no gating).
      const accessAnd = viewer
        ? Prisma.sql`AND (
            r.sharepoint_code IS NULL
            OR EXISTS (
              SELECT 1 FROM job_profile_access j
              WHERE j.job_title = ${viewer.jobTitle}
                AND j.department = ${viewer.department}
                AND j.sharepoint_code = r.sharepoint_code
            )
          )`
        : publicOnly
          ? Prisma.sql`AND r.sharepoint_code IS NULL`
          : Prisma.empty
      // Pull a wider candidate pool than k so RRF has room to re-rank — and
      // so the per-doc cap below has alternatives when a single doc would
      // otherwise sweep the top of one leg.
      const fetchSize = Math.max(k * 5, 30)
      // RRF k constant from Cormack et al. 2009. 60 is the canonical value;
      // it dampens contributions from low ranks without erasing them.
      const rrfK = 60

      type Row = {
        content: string
        metadata: Record<string, unknown> | null
        filename: string
        sharepoint_url: string | null
        source_metadata: Record<string, unknown> | null
        score: number
      }
      // Hybrid retrieval: rank candidates by vector cosine distance AND by
      // FTS ts_rank_cd in parallel, fuse via Reciprocal Rank Fusion (sum of
      // 1/(k+rank) across legs). RRF is robust to wildly different score
      // distributions, which is exactly the vector-vs-BM25 problem.
      //
      // The FTS leg uses `plainto_tsquery` so user input is sanitized; if
      // the query is all stopwords the tsquery is empty and the @@ match
      // returns no rows — that's fine, the vector leg still contributes.
      const rows = await this.prisma.$queryRaw<Row[]>`
        WITH q AS (
          SELECT plainto_tsquery('english', ${query}) AS tsq
        ),
        vec AS (
          SELECT e.id,
                 ROW_NUMBER() OVER (ORDER BY e.embedding <=> ${vec}::halfvec) AS rnk
          FROM embeddings e
          INNER JOIN resources r ON e.resource_id = r.id
          WHERE 1=1 ${filenameAnd} ${accessAnd}
          ORDER BY e.embedding <=> ${vec}::halfvec
          LIMIT ${fetchSize}
        ),
        fts AS (
          SELECT e.id,
                 ROW_NUMBER() OVER (ORDER BY ts_rank_cd(e.content_tsv, q.tsq) DESC) AS rnk
          FROM embeddings e
          INNER JOIN resources r ON e.resource_id = r.id
          CROSS JOIN q
          WHERE e.content_tsv @@ q.tsq ${filenameAnd} ${accessAnd}
          ORDER BY ts_rank_cd(e.content_tsv, q.tsq) DESC
          LIMIT ${fetchSize}
        ),
        fused AS (
          SELECT id, SUM(1.0 / (${rrfK} + rnk))::float AS score
          FROM (
            SELECT id, rnk FROM vec
            UNION ALL
            SELECT id, rnk FROM fts
          ) u
          GROUP BY id
        )
        SELECT e.content,
               e.metadata,
               r.filename,
               r.sharepoint_url,
               r.source_metadata,
               f.score
        FROM fused f
        INNER JOIN embeddings e ON e.id = f.id
        INNER JOIN resources r ON e.resource_id = r.id
        ORDER BY f.score DESC
        LIMIT ${fetchSize}
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
      const hits: SimilarityHit[] = picked.map((r) => {
        const srcMd = r.source_metadata ?? {}
        // "Open in browser" URL — DocIdRedir for sharepoint-list rows
        // (in source_metadata.link_url), webUrl for manual imports
        // (in resources.sharepoint_url). The agent uses this to build
        // clickable citations.
        const linkUrl =
          (typeof srcMd.link_url === 'string' ? srcMd.link_url : undefined) ??
          r.sharepoint_url ??
          undefined
        return {
          content: r.content,
          metadata: {
            ...(r.metadata ?? {}),
            filename: r.filename,
            link_url: linkUrl,
            // Hand the agent richer-than-filename context for display:
            code: typeof srcMd.code === 'string' ? srcMd.code : undefined,
            version: typeof srcMd.version === 'string' ? srcMd.version : undefined,
            title: typeof srcMd.title === 'string' ? srcMd.title : undefined,
          },
        }
      })

      // Count restricted top-N semantic candidates — i.e. resources that
      // would have ranked high for this query but were excluded by ACL. The
      // chat layer surfaces this as "you don't have permission to view N
      // matching document(s)" WITHOUT naming them, so a user can tell when
      // their query landed on something they're not entitled to read vs.
      // a query that genuinely matches nothing.
      let restrictedCount = 0
      if (viewer || publicOnly) {
        const restrictedAnd = viewer
          ? Prisma.sql`AND r.sharepoint_code IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM job_profile_access j
                WHERE j.job_title = ${viewer.jobTitle}
                  AND j.department = ${viewer.department}
                  AND j.sharepoint_code = r.sharepoint_code
              )`
          : Prisma.sql`AND r.sharepoint_code IS NOT NULL`
        try {
          const restrictedRows = await this.prisma.$queryRaw<{ n: number }[]>`
            SELECT COUNT(DISTINCT r.id)::int AS n
            FROM (
              SELECT e.resource_id
              FROM embeddings e
              INNER JOIN resources r ON e.resource_id = r.id
              WHERE 1=1 ${filenameAnd}
              ORDER BY e.embedding <=> ${vec}::halfvec
              LIMIT ${fetchSize}
            ) cand
            INNER JOIN resources r ON r.id = cand.resource_id
            WHERE 1=1 ${restrictedAnd}
          `
          restrictedCount = restrictedRows[0]?.n ?? 0
        } catch (err) {
          // Non-fatal — fall through with restrictedCount = 0 so chat still
          // responds. The allow-list query above already filtered the actual
          // hits; this only feeds the "you don't have permission" surfacing.
          console.warn('Restricted-count probe failed:', (err as Error).message)
        }
      }

      return { hits, restrictedCount }
    } catch (err) {
      // Match legacy behavior: swallow + log so chat can still respond
      // without RAG context if the vector index is unavailable.
      console.warn('Similarity search failed:', (err as Error).message)
      return { hits: [], restrictedCount: 0 }
    }
  }

  async listResourcesWithCounts(opts: {
    viewer?: ViewerProfile
    publicOnly?: boolean
  } = {}): Promise<DocumentInfo[]> {
    type Row = {
      id: string
      filename: string
      file_type: string
      source: string
      sharepoint_url: string | null
      sharepoint_code: string | null
      sharepoint_version: string | null
      sharepoint_pending_version: string | null
      sync_status: string
      sync_error: string | null
      source_metadata: Record<string, unknown> | null
      chunk_count: number
    }
    const accessAnd = opts.viewer
      ? Prisma.sql`AND (
          r.sharepoint_code IS NULL
          OR EXISTS (
            SELECT 1 FROM job_profile_access j
            WHERE j.job_title = ${opts.viewer.jobTitle}
              AND j.department = ${opts.viewer.department}
              AND j.sharepoint_code = r.sharepoint_code
          )
        )`
      : opts.publicOnly
        ? Prisma.sql`AND r.sharepoint_code IS NULL`
        : Prisma.empty
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT r.id,
             r.filename,
             r.file_type,
             r.source,
             r.sharepoint_url,
             r.sharepoint_code,
             r.sharepoint_version,
             r.sharepoint_pending_version,
             r.sync_status,
             r.sync_error,
             r.source_metadata,
             COUNT(e.id)::int AS chunk_count
      FROM resources r
      LEFT JOIN embeddings e ON e.resource_id = r.id
      WHERE 1=1 ${accessAnd}
      GROUP BY r.id
      ORDER BY r.created_at DESC
    `
    return rows.map((r) => {
      const md = r.source_metadata ?? {}
      const linkFromMetadata = typeof md.link_url === 'string' ? md.link_url : undefined
      return {
        id: r.id,
        filename: r.filename,
        fileType: r.file_type,
        chunkCount: r.chunk_count,
        source: r.source as DocumentInfo['source'],
        sharepointUrl: r.sharepoint_url ?? undefined,
        // sharepoint-list rows use the list's Link column; legacy
        // sharepoint imports fall back to sharepointUrl.
        linkUrl: linkFromMetadata ?? r.sharepoint_url ?? undefined,
        sharepointCode: r.sharepoint_code ?? undefined,
        sharepointVersion: r.sharepoint_version ?? undefined,
        sharepointPendingVersion: r.sharepoint_pending_version ?? undefined,
        syncStatus: r.sync_status as DocumentInfo['syncStatus'],
        syncError: r.sync_error ?? undefined,
        title: typeof md.title === 'string' ? md.title : undefined,
        distribution: typeof md.distribution === 'string' ? md.distribution : undefined,
      }
    })
  }
}
