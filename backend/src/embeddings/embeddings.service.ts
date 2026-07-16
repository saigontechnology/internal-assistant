import { embed, embedMany } from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { nanoid } from 'nanoid'
import { Prisma } from '@prisma/client'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { Semaphore } from '../common/semaphore.js'
import { withRetry } from '../common/retry.js'
import type { DocumentInfo, TextChunk } from '../common/types.js'
import { EMBEDDING_DIMENSION, type EmbeddingProbe } from './embedding-probe.js'
import { RetrievalUnavailableError } from './retrieval-error.js'

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
 * How many chunks are embedded per provider request, and how many rows go into
 * a single INSERT. Both bound the size of one unit of work: a batch that fails
 * is retried alone rather than dragging a 500-chunk document with it, and a
 * 2048-dim vector serialises to ~25KB of text, so an unbounded multi-row INSERT
 * would build a statement measured in tens of megabytes.
 */
const EMBED_BATCH_SIZE = 64
const INSERT_BATCH_SIZE = 50

/**
 * Owns everything that touches the embeddings table. The `halfvec(2048)`
 * column has no Prisma ORM mapping, so vector writes (insert) and reads
 * (KNN search) all go through `$queryRawUnsafe` / `$queryRaw` with the
 * vector cast inline as `::halfvec`.
 */
export class EmbeddingsService implements EmbeddingProbe {
  private readonly openai: OpenAIProvider

  /**
   * Caps concurrent embedding requests process-wide. Every retrieval embeds its
   * query, so without this 100 concurrent users produce 100 simultaneous
   * provider calls, get rate-limited as a group, and then retry as a group.
   * The limit is read per-acquire so /admin/settings changes take effect live.
   */
  private readonly embedLimiter = new Semaphore(() => this.settings.embeddingConcurrency)

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly settings: RuntimeSettingsService,
  ) {
    this.openai = buildOpenAIClient(this.config)
  }

  /** Queue depth, for the /health capacity readout. */
  get limiterStats(): { active: number; waiting: number } {
    return { active: this.embedLimiter.active, waiting: this.embedLimiter.waiting }
  }

  /**
   * Embed one string. Rate limits and upstream 5xx are retried with jittered
   * backoff; anything still failing after that throws, because a silent empty
   * result here is how the agent ends up confidently answering from nothing.
   */
  private async generateEmbedding(text: string, model = this.settings.embeddingModel): Promise<number[]> {
    return this.embedLimiter.run(() =>
      withRetry(
        async () => {
          const { embedding } = await embed({
            model: this.openai.textEmbeddingModel(model),
            value: text,
          })
          return embedding
        },
        { attempts: this.settings.llmMaxRetries, label: `embed:${model}` },
      ),
    )
  }

  /**
   * Embed many strings, in bounded batches. `maxParallelCalls: 1` hands
   * concurrency control to our semaphore rather than letting the SDK fan out
   * behind its back — an ingest of a 500-chunk document would otherwise blow
   * straight through the limit that protects interactive chat traffic.
   */
  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const model = this.settings.embeddingModel
    const out: number[][] = []

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
      const embeddings = await this.embedLimiter.run(() =>
        withRetry(
          async () => {
            const res = await embedMany({
              model: this.openai.textEmbeddingModel(model),
              values: batch,
              maxParallelCalls: 1,
            })
            return res.embeddings
          },
          { attempts: this.settings.llmMaxRetries, label: `embedMany:${model}` },
        ),
      )
      out.push(...embeddings)
    }

    return out
  }

  /**
   * Embed a probe string with `model` and report the vector's length.
   *
   * This is what makes EMBEDDING_MODEL safe to expose in the admin portal. The
   * `embedding` column is `halfvec(2048)` with an HNSW index built against it;
   * a model with a different output dimension does not error on write, it
   * writes vectors from a foreign embedding space into the same column and
   * corrupts retrieval silently. The settings write path calls this and refuses
   * any model whose output isn't exactly EMBEDDING_DIMENSION.
   *
   * Deliberately un-retried and un-queued: an admin is waiting on the response,
   * and "the provider is rate-limiting us" is a real answer to "can I switch to
   * this model right now?"
   */
  async probeDimension(model: string): Promise<number> {
    const { embedding } = await embed({
      model: this.openai.textEmbeddingModel(model),
      value: 'dimension probe',
    })
    return embedding.length
  }

  async addDocument(doc: DocumentDescriptor, chunks: TextChunk[]): Promise<number> {
    const vectors = await this.generateEmbeddings(chunks.map((c) => c.text))

    // A model swap between ingest runs is the one way a wrong-dimension vector
    // can still reach the column (the settings probe guards the write path, but
    // not a hand-edited app_settings row or an env change on redeploy).
    // Postgres would reject it anyway; failing here says why.
    const wrong = vectors.find((v) => v.length !== EMBEDDING_DIMENSION)
    if (wrong) {
      throw new Error(
        `Embedding model "${this.settings.embeddingModel}" returned ${wrong.length} dimensions, ` +
          `but the embeddings column is halfvec(${EMBEDDING_DIMENSION}). Refusing to write — ` +
          `changing the embedding model requires re-embedding the whole corpus.`,
      )
    }

    // Single transaction so a half-inserted document never lingers.
    //
    // The chunk rows go in as batched multi-row INSERTs rather than one
    // statement per chunk. The old loop issued N sequential round-trips while
    // holding a pool connection, so a 200-chunk document pinned one of the
    // pool's connections for 200 round-trips — during business hours a
    // SharePoint sync could hold a meaningful slice of the pool for minutes
    // while chat traffic queued behind it.
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

      for (let i = 0; i < chunks.length; i += INSERT_BATCH_SIZE) {
        const batch = chunks.slice(i, i + INSERT_BATCH_SIZE)
        const values = batch.map((chunk, j) => {
          const vec = JSON.stringify(vectors[i + j])
          return Prisma.sql`(${nanoid()}, ${doc.id}, ${chunk.text}, ${vec}::halfvec, ${chunk.metadata}::jsonb)`
        })
        await tx.$executeRaw`
          INSERT INTO embeddings (id, resource_id, content, embedding, metadata)
          VALUES ${Prisma.join(values)}
        `
      }
    })

    return chunks.length
  }

  async deleteDocument(docId: string): Promise<void> {
    // FK is ON DELETE CASCADE, so embeddings go with the resource row.
    await this.prisma.resource.delete({ where: { id: docId } }).catch(() => {})
  }

  /**
   * Hybrid retrieval: vector ANN + full-text, fused with Reciprocal Rank
   * Fusion, access-filtered, then capped per document.
   *
   * **One vector scan, not two.** The previous version ran the HNSW scan twice
   * per retrieval — once for the hits, and again, unfiltered, purely to count
   * how many matching documents the viewer wasn't allowed to see. That doubled
   * the cost of the single most expensive operation in the system, on every
   * retrieval, for every authenticated user. Both answers come out of the same
   * candidate pool now: `cand` is scanned once, `acl` labels each candidate,
   * the accessible ones feed the fusion and the rest feed the count.
   *
   * The access filter also moved *out* of the vector scan. Inside it, the
   * planner was free to decide the filter was selective and abandon the HNSW
   * index for a sequential scan that computed a distance for every row in the
   * table — the classic pgvector filtering trap, and a cliff you only fall off
   * once the corpus is big enough to matter. Scanning first and filtering after
   * makes the plan stable and predictable. The trade is recall: a viewer with
   * narrow access sees fewer of their accessible chunks survive the pool. That
   * is what `retrieval.candidate_pool` and `PGVECTOR_EF_SEARCH` are for — both
   * are sized well above `top_k` to leave room, and the pool is admin-tunable.
   */
  async similaritySearch(
    query: string,
    opts: SimilaritySearchOptions = {},
  ): Promise<SimilaritySearchResult> {
    const {
      k = this.settings.retrievalTopK,
      filenames,
      maxPerDoc = this.settings.retrievalMaxPerDoc,
      viewer,
      publicOnly,
    } = opts

    // Embedding failures throw — see RetrievalUnavailableError. Everything
    // below this line is database work.
    let queryEmbedding: number[]
    try {
      queryEmbedding = await this.generateEmbedding(query)
    } catch (err) {
      throw new RetrievalUnavailableError(
        `Could not embed the search query: ${(err as Error).message}`,
        err,
      )
    }

    const vec = JSON.stringify(queryEmbedding)

    // Candidate pool per leg, before fusion / access filtering / the per-doc
    // cap. Floored well above k so those three stages have something to choose
    // between; see PGVECTOR_EF_SEARCH, which must be at least this large or the
    // index simply won't return this many candidates.
    const fetchSize = Math.max(this.settings.retrievalCandidatePool, k * 3)
    // RRF k constant from Cormack et al. 2009. 60 is the canonical value; it
    // dampens contributions from low ranks without erasing them.
    const rrfK = 60

    const filenameAnd =
      filenames && filenames.length > 0
        ? Prisma.sql`AND r.filename IN (${Prisma.join(filenames)})`
        : Prisma.empty

    // Access predicate, as a boolean expression rather than a WHERE clause, so
    // the same evaluation can both gate the hits and count the exclusions.
    // `viewer` opens the job_profile_access allow-list for that tuple;
    // `publicOnly` restricts to docs with NULL sharepoint_code; omitting both
    // is admin mode (no gating, and therefore nothing restricted to count).
    const allowedExpr = viewer
      ? Prisma.sql`(
          r.sharepoint_code IS NULL
          OR EXISTS (
            SELECT 1 FROM job_profile_access j
            WHERE j.job_title = ${viewer.jobTitle}
              AND j.department = ${viewer.department}
              AND j.sharepoint_code = r.sharepoint_code
          )
        )`
      : publicOnly
        ? Prisma.sql`(r.sharepoint_code IS NULL)`
        : Prisma.sql`TRUE`

    type Row = {
      // Always present — `stats` is a bare aggregate, so it yields exactly one
      // row even when nothing matched, which is precisely the ACCESS_DENIED
      // case where the count is the only thing we have to say.
      restricted_count: number
      content: string | null
      metadata: Record<string, unknown> | null
      filename: string | null
      sharepoint_url: string | null
      source_metadata: Record<string, unknown> | null
      /**
       * Parsed form of source_metadata.date, populated on every SharePoint
       * write. Null when the source value was missing or unparseable. Preferred
       * over the raw string, which is free-text ("23-Apr-25", "23-Apr-2025")
       * and not reliably orderable.
       */
      file_date: Date | null
      score: number | null
    }

    let rows: Row[]
    try {
      rows = await this.prisma.$queryRaw<Row[]>`
        WITH q AS (
          SELECT plainto_tsquery('english', ${query}) AS tsq
        ),
        -- The single HNSW scan. No access predicate here, deliberately: it
        -- keeps the plan on the index, and the pool is shared with the count.
        cand AS (
          SELECT e.id,
                 e.resource_id,
                 e.embedding <=> ${vec}::halfvec AS dist
          FROM embeddings e
          INNER JOIN resources r ON e.resource_id = r.id
          WHERE 1=1 ${filenameAnd}
          ORDER BY e.embedding <=> ${vec}::halfvec
          LIMIT ${fetchSize}
        ),
        -- Label each candidate. One cheap join over at most fetchSize rows.
        acl AS (
          SELECT c.id,
                 c.resource_id,
                 c.dist,
                 ${allowedExpr} AS allowed
          FROM cand c
          INNER JOIN resources r ON r.id = c.resource_id
        ),
        vec_leg AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY dist) AS rnk
          FROM acl
          WHERE allowed
        ),
        -- FTS leg keeps the predicate inline: it's a GIN scan, so filtering
        -- inside costs nothing and can't push the planner off the index.
        fts_leg AS (
          SELECT e.id,
                 ROW_NUMBER() OVER (ORDER BY ts_rank_cd(e.content_tsv, q.tsq) DESC) AS rnk
          FROM embeddings e
          INNER JOIN resources r ON e.resource_id = r.id
          CROSS JOIN q
          WHERE e.content_tsv @@ q.tsq
            AND ${allowedExpr}
            ${filenameAnd}
          ORDER BY ts_rank_cd(e.content_tsv, q.tsq) DESC
          LIMIT ${fetchSize}
        ),
        fused AS (
          SELECT id, SUM(1.0 / (${rrfK} + rnk))::float AS score
          FROM (
            SELECT id, rnk FROM vec_leg
            UNION ALL
            SELECT id, rnk FROM fts_leg
          ) u
          GROUP BY id
        ),
        stats AS (
          SELECT COUNT(DISTINCT resource_id) FILTER (WHERE NOT allowed)::int AS restricted
          FROM acl
        )
        SELECT s.restricted AS restricted_count,
               e.content,
               e.metadata,
               r.filename,
               r.sharepoint_url,
               r.source_metadata,
               r.file_date,
               f.score
        FROM stats s
        LEFT JOIN fused f ON TRUE
        LEFT JOIN embeddings e ON e.id = f.id
        LEFT JOIN resources r ON r.id = e.resource_id
        ORDER BY f.score DESC NULLS LAST
        LIMIT ${fetchSize}
      `
    } catch (err) {
      // A failed vector search used to be swallowed so chat could answer
      // without RAG. It can't: answering a document question with no documents
      // and no warning is worse than saying retrieval is down.
      throw new RetrievalUnavailableError(
        `Vector search failed: ${(err as Error).message}`,
        err,
      )
    }

    const restrictedCount = rows[0]?.restricted_count ?? 0
    // `stats` guarantees one row; when nothing matched, its hit columns are
    // NULL from the LEFT JOIN. Drop those — they're the placeholder, not a hit.
    const matched = rows.filter((r): r is Row & { content: string; filename: string } =>
      r.content !== null && r.filename !== null,
    )

    // Prefer the latest version. The same logical document (same sharepoint
    // `code`) can appear in the candidate pool as multiple versions — across
    // lists, re-uploads, or version-stamped filenames — and semantic ranking
    // alone will happily surface an OLD version if its wording matches the
    // query better. That's how the agent ends up answering from a superseded
    // document. So: find the newest version present per code, then drop every
    // chunk belonging to an older version before we pick.
    const rowVersion = (r: Row): string => {
      const v = (r.source_metadata ?? {}).version
      return typeof v === 'string' ? v : ''
    }
    const rowCode = (r: Row): string | undefined => {
      const c = (r.source_metadata ?? {}).code
      return typeof c === 'string' && c ? c : undefined
    }
    const latestVersionByCode = new Map<string, string>()
    for (const r of matched) {
      const code = rowCode(r)
      if (!code) continue
      const v = rowVersion(r)
      const best = latestVersionByCode.get(code)
      if (best === undefined || compareVersions(v, best) > 0) {
        latestVersionByCode.set(code, v)
      }
    }

    // Cap per-document so a single dominant file can't drown out the rest.
    const perDoc = new Map<string, number>()
    const picked: (Row & { content: string; filename: string })[] = []
    for (const r of matched) {
      const code = rowCode(r)
      if (code) {
        const latest = latestVersionByCode.get(code)
        // Skip stale versions of a document we have a newer version of.
        if (latest !== undefined && compareVersions(rowVersion(r), latest) < 0) continue
      }
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
          // Raw free-text value from the SP "Date" column — kept for
          // display fallback when file_date failed to parse.
          date: typeof srcMd.date === 'string' ? srcMd.date : undefined,
          // Parsed ISO date (YYYY-MM-DD) — this is what the chat agent
          // should use to compare recency across conflicting documents.
          file_date:
            r.file_date instanceof Date
              ? r.file_date.toISOString().slice(0, 10)
              : undefined,
        },
      }
    })

    return { hits, restrictedCount }
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
    // Chunk counts come from a correlated aggregate rather than a
    // LEFT JOIN + GROUP BY over the whole embeddings table: the join form
    // built one row per chunk (tens of thousands) only to collapse them again,
    // and this endpoint is hit on every page load.
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
             (SELECT COUNT(*)::int FROM embeddings e WHERE e.resource_id = r.id) AS chunk_count
      FROM resources r
      WHERE 1=1 ${accessAnd}
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

/**
 * Compare two document version strings. Returns >0 when `a` is newer than `b`,
 * <0 when older, 0 when equal. Handles the common shapes in this corpus —
 * plain integers ("07" vs "03") and dotted versions ("1.10" vs "1.9") — by
 * comparing dot-separated segments numerically. Non-digit characters within a
 * segment (e.g. a stray "v") are stripped; a missing segment counts as 0, so
 * "1" and "1.0" are equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((s) => parseInt(s.replace(/[^\d]/g, ''), 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
