import { z } from 'zod'

/**
 * A bounded integer env var that tolerates being *set to empty*.
 *
 * The deploy workflow renders `.env` from GitHub repo variables, and an unset
 * variable interpolates to the empty string rather than being omitted — so the
 * app sees `POSTGRES_POOL_MAX=`. Plain `z.coerce.number()` turns `''` into `0`,
 * which then fails a `min(1)` bound and takes the whole boot down. Any var with
 * a lower bound that a deployment is expected to leave unset must go through
 * this, or shipping without setting it is a crash rather than a default.
 */
function boundedInt(opts: { min: number; max?: number; default: number }) {
  const base = opts.max === undefined
    ? z.coerce.number().int().min(opts.min)
    : z.coerce.number().int().min(opts.min).max(opts.max)
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    base.default(opts.default),
  )
}

/**
 * Single source of truth for env validation. Mirrors the legacy
 * `src/config.ts` schema so both stacks read the same vars during the
 * Hono → NestJS rewrite window.
 */
export const envSchema = z.object({
  OPENAI_API_BASE: z.string().default('https://openrouter.ai/api/v1'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  CHAT_MODEL: z.string().default('deepseek/deepseek-v4-flash:free'),
  EMBEDDING_MODEL: z.string().default('nvidia/llama-nemotron-embed-vl-1b-v2:free'),
  // Steps in one agent turn: each retrieval round-trip is a step, and the
  // answer itself needs one. The last step runs with tools disabled, so the
  // real retrieval budget is CHAT_MAX_STEPS - 1. Below 2 there is no room to
  // both search and answer. Editable at /admin/settings.
  CHAT_MAX_STEPS: boundedInt({ min: 2, max: 12, default: 6 }),
  // How many prior messages are replayed to the model each turn. The full
  // conversation still persists and still renders in the UI — this only bounds
  // what we pay to re-send. Tool results are the reason it matters: one
  // retrieval round returns ~8 excerpts of ~1KB, so an untrimmed 20-turn chat
  // ships hundreds of KB of stale excerpts on every request, and both cost and
  // time-to-first-token grow linearly with conversation length.
  // Editable at /admin/settings.
  CHAT_HISTORY_WINDOW: boundedInt({ min: 2, max: 200, default: 20 }),
  // Hard cap on messages kept in `chat_histories.messages`. The column is a
  // single JSON blob that is read *and rewritten in full* on every turn, so an
  // unbounded chat becomes an unbounded write amplifier. Oldest messages are
  // dropped past this. Editable at /admin/settings.
  CHAT_HISTORY_MAX_PERSISTED: boundedInt({ min: 10, max: 2000, default: 200 }),

  // ── Retrieval ──
  // All editable at /admin/settings; these are the fallbacks.
  // Excerpts handed to the model per retrieval.
  RETRIEVAL_TOP_K: boundedInt({ min: 1, max: 50, default: 8 }),
  // Cap per document, so one dominant file can't sweep the whole result set.
  RETRIEVAL_MAX_PER_DOC: boundedInt({ min: 1, max: 20, default: 3 }),
  // Candidates pulled from each retrieval leg (vector + FTS) before fusion,
  // access filtering, and the per-doc cap. Needs slack above TOP_K or those
  // three stages have nothing to choose from. Keep ≤ PGVECTOR_EF_SEARCH.
  RETRIEVAL_CANDIDATE_POOL: boundedInt({ min: 10, max: 500, default: 60 }),

  // ── Outbound provider limits ──
  // All editable at /admin/settings; these are the fallbacks.
  // Attempts per provider call, including the first. Applies to embeddings and
  // to the model catalog fetch. 1 disables retrying.
  LLM_MAX_RETRIES: boundedInt({ min: 1, max: 10, default: 3 }),
  // Concurrent in-flight embedding requests, process-wide. Every retrieval
  // embeds its query, so at 100 CCU this is the valve between a steady stream
  // the provider will serve and a burst it will rate-limit.
  EMBEDDING_CONCURRENCY: boundedInt({ min: 1, max: 100, default: 8 }),
  // Concurrent in-flight chat generations, process-wide. Excess turns queue
  // rather than pile onto the provider. Should exceed EMBEDDING_CONCURRENCY —
  // a generation spends most of its life streaming, not embedding.
  CHAT_CONCURRENCY: boundedInt({ min: 1, max: 500, default: 25 }),

  // ── Rate limiting ──
  // Per authenticated session (falling back to client IP), sliding one-minute
  // window. Editable at /admin/settings. 0 disables the limit.
  RATE_LIMIT_PER_MINUTE: boundedInt({ min: 0, max: 10_000, default: 120 }),
  // Separate, much tighter budget for POST /api/chat, which is the only route
  // that costs a model call. The general limit alone can't protect it: 120
  // cheap GETs and 120 chat turns are not the same load.
  CHAT_RATE_LIMIT_PER_MINUTE: boundedInt({ min: 0, max: 1000, default: 20 }),

  // How long SIGTERM waits for in-flight chat streams to finish before
  // aborting them. Deploys recreate the container, so without this every
  // user mid-answer loses it. Env-only — read once, during shutdown.
  SHUTDOWN_DRAIN_TIMEOUT_MS: boundedInt({ min: 0, default: 25_000 }),

  // Chat provider switch. Only affects the chat/generation path; the
  // embedding pipeline stays on OpenRouter (via the OPENAI_*  vars)
  // regardless. See docs/gemini-migration-plan.md and
  // docs/opencode-migration-plan.md.
  CHAT_PROVIDER: z.enum(['openai', 'gemini', 'opencode']).default('openai'),
  // Google Generative AI credentials + model IDs. Required when
  // CHAT_PROVIDER=gemini; optional otherwise so local dev on the OpenAI
  // path doesn't need a Google key.
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GEMINI_CHAT_MODEL: z.string().default('gemini-2.5-flash-lite'),
  // First-tier fallback: same generation as the primary so tool-call format
  // and answer style stay consistent across failover.
  GEMINI_CHAT_FALLBACK_MODEL: z.string().default('gemini-2.5-flash'),
  // Second-tier fallback: independent quota bucket, reached only when the
  // first fallback is also cooling down. Provides one more rung before we
  // surface a hard error to the user. See docs/gemini-migration-plan.md §5.
  GEMINI_CHAT_SECOND_FALLBACK_MODEL: z.string().default('gemini-3.1-flash'),

  // OpenCode gateway (opencode.ai) — OpenAI-compatible endpoint used for
  // chat/generation only. See docs/opencode-migration-plan.md.
  // Base URL points at the parent path; @ai-sdk/openai appends
  // /chat/completions itself.
  OPENCODE_API_BASE: z.string().default('https://opencode.ai/zen/go/v1'),
  // Required when CHAT_PROVIDER=opencode; optional otherwise so local dev
  // on the openai/gemini paths doesn't need an OpenCode key.
  OPENCODE_API_KEY: z.string().optional(),
  // Model ids are the **bare** ids the gateway's `GET /models` returns
  // (`glm-5.2`), NOT the `<provider>/<model>` form (`zai/glm-5.2`) — the
  // prefixed form is not in the catalog and fails at stream time. These are
  // only the fallback defaults: admins pick the live ladder at
  // /admin/chat-model, which validates against the catalog. See
  // chat/chat-settings.service.ts and docs/opencode-migration-plan.md §2.
  OPENCODE_CHAT_MODEL: z.string().default('glm-5.2'),
  OPENCODE_CHAT_FALLBACK_MODEL: z.string().default('kimi-k2.6'),
  OPENCODE_CHAT_SECOND_FALLBACK_MODEL: z.string().default('minimax-m3'),
  CHUNK_SIZE: z.coerce.number().default(1000),
  CHUNK_OVERLAP: z.coerce.number().default(200),

  POSTGRES_HOST: z.string().min(1, 'POSTGRES_HOST is required'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1, 'POSTGRES_USER is required'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD is required'),
  POSTGRES_DB: z.string().min(1, 'POSTGRES_DB is required'),

  // ── Connection pool ──
  // Read once, when PrismaModule builds the pg Pool, so this is env-only.
  //
  // `pg-pool` defaults to 10, which is what the app shipped with. One chat turn
  // costs roughly a dozen light queries plus one vector scan per retrieval, so
  // ten connections saturate at well under 100 concurrent users and every
  // request — including the session lookup on unrelated routes — starts
  // queueing behind someone else's HNSW scan. Size this against Postgres's
  // `max_connections` (see docker-compose.yml): pool_max × backend_instances
  // must leave headroom for migrations, psql, and Prisma Studio.
  POSTGRES_POOL_MAX: boundedInt({ min: 1, max: 200, default: 30 }),
  // Return a connection to the OS after this long idle. Keeps the steady-state
  // count near the working set rather than pinned at the high-water mark.
  POSTGRES_POOL_IDLE_TIMEOUT_MS: boundedInt({ min: 1000, default: 30_000 }),
  // Fail fast when the pool is exhausted instead of hanging the request
  // forever. Surfaces as a 500 with a clear message — which is what you want
  // pointing at the pool during a load test.
  POSTGRES_POOL_CONNECTION_TIMEOUT_MS: boundedInt({ min: 1000, default: 10_000 }),
  // Server-side backstop: kill any single statement that runs longer than this.
  // A pathological vector scan (see PGVECTOR_EF_SEARCH) could otherwise hold a
  // pool connection open indefinitely and take the whole pool with it.
  // 0 disables. Applied as a connection startup option, so it covers raw SQL too.
  POSTGRES_STATEMENT_TIMEOUT_MS: boundedInt({ min: 0, default: 30_000 }),

  // Size of the HNSW candidate list pgvector walks per query. Higher = better
  // recall, more CPU. pgvector's default is 40, which is *below* the candidate
  // pool this app asks for, so the index was silently the recall bottleneck.
  // Must be ≥ retrieval.candidate_pool to be worth anything.
  // Applied as a connection startup option (`-c hnsw.ef_search=N`) because
  // `SET LOCAL` would require pinning a transaction around every search.
  PGVECTOR_EF_SEARCH: boundedInt({ min: 1, max: 1000, default: 120 }),

  AZURE_CLIENT_ID: z.string().min(1, 'AZURE_CLIENT_ID is required'),
  AZURE_TENANT_ID: z.string().min(1, 'AZURE_TENANT_ID is required'),
  AZURE_CLIENT_SECRET: z.string().min(1, 'AZURE_CLIENT_SECRET is required'),
  AZURE_REDIRECT_URI: z.string().default('http://localhost:5173/api/auth/callback'),

  FRONTEND_URL: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(1).default('dev-insecure-secret-change-me'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  // Comma-separated bootstrap admins for the /admin portal, e.g.
  // "alice@corp.com,bob@corp.com". These are promoted to role='admin' at boot
  // and on every login. Promotion is one-way: removing an email here does NOT
  // demote them — use the portal for that. Empty = no bootstrap admin, in
  // which case the first admin must be set directly in the DB.
  ADMIN_EMAILS: z.string().default(''),

  // Redis backing store for resumable-stream. Publishes chat SSE chunks so a
  // reconnecting client (page refresh, network drop) can pick up mid-stream
  // via GET /api/chat/:id/stream. Required — the chat resume path won't boot
  // without it.
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),

  // Optional. When set, sent as the `Host` header on every outbound OpenAI
  // request. Workaround for upstream proxies that gate on Host (e.g. our
  // 9router instance on the VPS returns 401 unless Host is 127.0.0.1:20128).
  // Leave empty in local dev when 9router is reached directly.
  OPENAI_HOST_OVERRIDE: z.string().optional(),

  // SharePoint List watcher (Phase A). Resolved at sync time and cached in-process.
  SHAREPOINT_TENANT_HOSTNAME: z.string().min(1).default('saigontechnology0.sharepoint.com'),
  SHAREPOINT_SITE_PATH: z.string().min(1).default('/QA/ISOTEAM'),
  // Name of the **registry list** that maps List Name → target list URL.
  // Matched case-insensitively. Every row in the registry becomes one
  // distribution_lists row, and its Link column dereferences to the actual
  // SharePoint list we sync. See docs/multi-list-watcher-plan.md.
  SHAREPOINT_LIST_NAME: z.string().min(1).default('Document Distribution List'),
  // Optional. When > 0, target-list iteration adds an incremental filter
  // on lastModifiedDateTime ≥ (last_synced_at - N days). 0 = full sync each
  // run (current behavior). The window provides slop for clock skew.
  SHAREPOINT_REGISTRY_INCREMENTAL_WINDOW_DAYS: z.coerce.number().int().min(0).default(0),

  // How many days between weekly resyncs. A logged-in user whose
  // user_permissions.lastSync AND their job_profile.lastSync are both older
  // than this triggers a background job-profile re-scan.
  USER_SYNC_INTERVAL_DAYS: z.coerce.number().int().positive().default(7),

  // Default fallback job profile. When a user's own profile is mid-scan or
  // not yet known to the system, the chat filter falls back to this profile's
  // allow-list. Both values are normalized (trim + lowercase) at boot.
  DEFAULT_JOB_TITLE: z.string().default('Developer'),
  DEFAULT_DEPARTMENT: z.string().default('SDC 1'),
}).superRefine((env, ctx) => {
  if (env.CHAT_PROVIDER === 'gemini' && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GOOGLE_GENERATIVE_AI_API_KEY'],
      message: 'GOOGLE_GENERATIVE_AI_API_KEY is required when CHAT_PROVIDER=gemini',
    })
  }
  if (env.CHAT_PROVIDER === 'opencode' && !env.OPENCODE_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENCODE_API_KEY'],
      message: 'OPENCODE_API_KEY is required when CHAT_PROVIDER=opencode',
    })
  }
})

export type Env = z.infer<typeof envSchema>

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw)
  if (!parsed.success) {
    const errors = parsed.error.flatten().fieldErrors
    throw new Error(`Invalid environment: ${JSON.stringify(errors)}`)
  }
  return parsed.data
}
