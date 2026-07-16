import { AppConfig } from '../config/app-config.service.js'
import { EMBEDDING_DIMENSION, type EmbeddingProbe } from '../embeddings/embedding-probe.js'

/**
 * The settings an admin may change at runtime, and the env var each one falls
 * back to. This registry is the single source of truth: it drives validation
 * in the controller, the reset surface, and the rendered admin form.
 *
 * Deliberately absent, and why:
 *
 * - `CHAT_PROVIDER`, `OPENAI_API_BASE`, `OPENCODE_API_BASE` — consumed when
 *   ChatService builds its SDK clients in the constructor. An editable field
 *   that needs a restart to take effect is worse than no field.
 * - The Postgres pool (`POSTGRES_POOL_MAX` and friends) and `PGVECTOR_EF_SEARCH`
 *   — same reason: they're applied when PrismaModule opens the pool, and
 *   `hnsw.ef_search` rides on the connection itself.
 * - Every secret and every Postgres/Redis/Azure/session var — storing these in
 *   `app_settings` would put plaintext credentials in the database and render
 *   them into an admin page.
 * - `opencode.*` — owned by ChatSettingsService and edited at /admin/chat-model,
 *   which validates model ids against the live gateway catalog. Keys here and
 *   there are disjoint on purpose.
 *
 * `EMBEDDING_MODEL` used to be on that list, on the grounds that a model with a
 * different output dimension writes vectors from a foreign embedding space into
 * the `halfvec(2048)` column without erroring, silently corrupting retrieval.
 * That risk is real, but it argues for a validated write path, not an absent
 * one — leaving the field out just meant the only way to get off a rate-limited
 * free-tier model was a redeploy. It's editable now, and `validate` below
 * probes the candidate model and refuses anything that isn't exactly
 * EMBEDDING_DIMENSION wide. Switching to a *different* model of the same width
 * is still a corpus-wide re-embed — the help text says so — but that's a
 * warning to heed, not a reason to make the field unreachable.
 */
export type SettingGroup = 'chat' | 'retrieval' | 'limits' | 'ingest' | 'sharepoint' | 'users'

export const SETTING_GROUPS: { group: SettingGroup; title: string; blurb: string }[] = [
  {
    group: 'chat',
    title: 'Chat models',
    blurb:
      'Used only when CHAT_PROVIDER selects them. The OpenCode ladder lives on the Chat model page.',
  },
  {
    group: 'retrieval',
    title: 'Retrieval',
    blurb:
      'How documents are found. Raising the candidate pool improves recall for narrowly-permissioned users at the cost of database CPU per search.',
  },
  {
    group: 'limits',
    title: 'Capacity & rate limits',
    blurb:
      'What the app does under load. Concurrency caps queue work instead of stampeding the model provider; rate limits stop one client monopolising it.',
  },
  {
    group: 'ingest',
    title: 'Chunking',
    blurb:
      'Applies to newly ingested documents only — existing chunks keep the sizing they were created with, so changing these makes the corpus mixed.',
  },
  { group: 'sharepoint', title: 'SharePoint sync', blurb: 'Read on the watcher\'s next run.' },
  { group: 'users', title: 'Users & access', blurb: 'Job-profile sync and the fallback profile.' },
]

/**
 * Services a `validate` hook may reach for. Passed in by the admin controller
 * so the registry stays a plain data module — importing EmbeddingsService here
 * would drag its whole dependency tree into everything that reads a setting.
 */
export interface SettingValidationContext {
  embeddings: EmbeddingProbe
}

export interface SettingDef {
  /** `app_settings.key`. Dotted and stable — renaming orphans stored overrides. */
  key: string
  group: SettingGroup
  label: string
  help: string
  kind: 'string' | 'number'
  /** Name of the env var this falls back to, shown in the UI. */
  envVar: string
  /** The effective env default, for display and for reset. */
  envDefault: (c: AppConfig) => string
  /** Inclusive bounds, `kind: 'number'` only. */
  min?: number
  max?: number
  /** When true an empty string is a legal value. */
  allowEmpty?: boolean
  /**
   * Checks that can't be expressed as a type or a range — currently just the
   * embedding model's output dimension, which can only be known by asking the
   * provider. Runs before anything is written, and throws with a
   * user-facing message to reject the save.
   */
  validate?: (value: string, ctx: SettingValidationContext) => Promise<void>
  /** Rendered as a warning next to the field. For changes with blast radius. */
  danger?: string
}

export const SETTING_DEFS: SettingDef[] = [
  // ── Chat ──
  {
    key: 'chat.model',
    group: 'chat',
    label: 'OpenRouter chat model',
    help: 'Used when CHAT_PROVIDER=openai. An OpenRouter slug, e.g. deepseek/deepseek-v4-flash:free.',
    kind: 'string',
    envVar: 'CHAT_MODEL',
    envDefault: (c) => c.chatModel,
  },
  {
    key: 'chat.gemini_model',
    group: 'chat',
    label: 'Gemini primary',
    help: 'First rung of the Gemini fallback ladder. Used when CHAT_PROVIDER=gemini.',
    kind: 'string',
    envVar: 'GEMINI_CHAT_MODEL',
    envDefault: (c) => c.geminiChatModel,
  },
  {
    key: 'chat.gemini_fallback_model',
    group: 'chat',
    label: 'Gemini first fallback',
    help: 'Used while the primary is cooling down after a 429.',
    kind: 'string',
    envVar: 'GEMINI_CHAT_FALLBACK_MODEL',
    envDefault: (c) => c.geminiChatFallbackModel,
  },
  {
    key: 'chat.gemini_second_fallback_model',
    group: 'chat',
    label: 'Gemini second fallback',
    help: 'Last rung before chat surfaces an error. Should sit in a separate quota bucket.',
    kind: 'string',
    envVar: 'GEMINI_CHAT_SECOND_FALLBACK_MODEL',
    envDefault: (c) => c.geminiChatSecondFallbackModel,
  },
  {
    key: 'chat.max_steps',
    group: 'chat',
    label: 'Max steps per answer',
    help: 'Each document search is one step and the written answer needs one more, so the search budget is this minus 1. Raise it if answers to hard questions feel under-researched; lower it to cut cost, since every step is a separate model request. Applies to all providers.',
    kind: 'number',
    envVar: 'CHAT_MAX_STEPS',
    envDefault: (c) => String(c.chatMaxSteps),
    min: 2,
    max: 12,
  },
  {
    key: 'chat.history_window',
    group: 'chat',
    label: 'History replayed to the model',
    help: 'How many recent messages are re-sent to the model each turn. The full conversation is still stored and still shown to the user — this only bounds what we pay to re-send. Retrieved excerpts live in the history, so a long chat that replays all of it costs more and answers slower with every turn. Lower this if long conversations feel sluggish.',
    kind: 'number',
    envVar: 'CHAT_HISTORY_WINDOW',
    envDefault: (c) => String(c.chatHistoryWindow),
    min: 2,
    max: 200,
  },
  {
    key: 'chat.history_max_persisted',
    group: 'chat',
    label: 'Max messages kept per chat',
    help: 'Hard cap on stored conversation length. Past this, the oldest messages are dropped permanently — the user loses that scrollback. Exists because the whole conversation is rewritten to the database on every turn, so an unbounded chat slows down every other user.',
    kind: 'number',
    envVar: 'CHAT_HISTORY_MAX_PERSISTED',
    envDefault: (c) => String(c.chatHistoryMaxPersisted),
    min: 10,
    max: 2000,
    danger: 'Lowering this permanently deletes older messages from chats that exceed the new cap.',
  },

  // ── Retrieval ──
  {
    key: 'retrieval.embedding_model',
    group: 'retrieval',
    label: 'Embedding model',
    help: `The model used to embed both documents and search queries. Must output exactly ${EMBEDDING_DIMENSION} dimensions — the value is probed against the provider when you save, and rejected if it doesn't match. Move off a ":free" OpenRouter model here: free tiers are capped at roughly 20 requests/minute, and every search costs one, so they rate-limit long before this app is busy.`,
    kind: 'string',
    envVar: 'EMBEDDING_MODEL',
    envDefault: (c) => c.embeddingModel,
    danger: `Changing to a different model — even one of the same width — invalidates every stored vector, because the old and new models don't share an embedding space. Retrieval quality degrades until the whole corpus is re-embedded.`,
    validate: async (value, ctx) => {
      let dim: number
      try {
        dim = await ctx.embeddings.probeDimension(value)
      } catch (err) {
        throw new Error(
          `Could not reach "${value}" at the embedding provider: ${(err as Error).message}. ` +
            `Check the model id and that OPENAI_API_KEY has access to it.`,
        )
      }
      if (dim !== EMBEDDING_DIMENSION) {
        throw new Error(
          `"${value}" returns ${dim}-dimension vectors, but the embeddings column is ` +
            `halfvec(${EMBEDDING_DIMENSION}). Storing them would corrupt retrieval rather than ` +
            `fail loudly, so this model cannot be used without a schema migration and a full re-embed.`,
        )
      }
    },
  },
  {
    key: 'retrieval.top_k',
    group: 'retrieval',
    label: 'Excerpts per search',
    help: 'How many document excerpts each search hands to the model. More context per search, but more tokens on every step that follows.',
    kind: 'number',
    envVar: 'RETRIEVAL_TOP_K',
    envDefault: (c) => String(c.retrievalTopK),
    min: 1,
    max: 50,
  },
  {
    key: 'retrieval.max_per_doc',
    group: 'retrieval',
    label: 'Max excerpts from one document',
    help: 'Stops a single dominant file sweeping the whole result set and crowding out other documents that also answer the question.',
    kind: 'number',
    envVar: 'RETRIEVAL_MAX_PER_DOC',
    envDefault: (c) => String(c.retrievalMaxPerDoc),
    min: 1,
    max: 20,
  },
  {
    key: 'retrieval.candidate_pool',
    group: 'retrieval',
    label: 'Candidate pool',
    help: `Rows pulled from the index before ranking, access filtering, and the per-document cap. Needs comfortable slack above "Excerpts per search" or those stages have nothing to choose between. Raise it if users with narrow document access get thin results; it costs database CPU on every search. Capped in practice by PGVECTOR_EF_SEARCH — going above that value has no effect.`,
    kind: 'number',
    envVar: 'RETRIEVAL_CANDIDATE_POOL',
    envDefault: (c) => String(c.retrievalCandidatePool),
    min: 10,
    max: 500,
  },

  // ── Capacity & rate limits ──
  {
    key: 'limits.embedding_concurrency',
    group: 'limits',
    label: 'Concurrent embedding requests',
    help: 'How many searches may be embedding at once, across the whole server. Excess searches queue. This is the valve that keeps a burst of users from arriving at the provider as one spike and getting the whole batch rate-limited.',
    kind: 'number',
    envVar: 'EMBEDDING_CONCURRENCY',
    envDefault: (c) => String(c.embeddingConcurrency),
    min: 1,
    max: 100,
  },
  {
    key: 'limits.chat_concurrency',
    group: 'limits',
    label: 'Concurrent generations',
    help: 'How many answers may be generating at once, across the whole server. Beyond this, turns queue rather than piling onto the model provider. Should sit well above the embedding cap — a generation spends most of its life streaming, not searching.',
    kind: 'number',
    envVar: 'CHAT_CONCURRENCY',
    envDefault: (c) => String(c.chatConcurrency),
    min: 1,
    max: 500,
  },
  {
    key: 'limits.llm_max_retries',
    group: 'limits',
    label: 'Provider retry attempts',
    help: 'Attempts per provider call, including the first. Rate limits and upstream 5xx are retried with growing, randomised delays; a bad model id is not. Set to 1 to disable retrying.',
    kind: 'number',
    envVar: 'LLM_MAX_RETRIES',
    envDefault: (c) => String(c.llmMaxRetries),
    min: 1,
    max: 10,
  },
  {
    key: 'limits.rate_limit_per_minute',
    group: 'limits',
    label: 'Requests per minute (per user)',
    help: 'Sliding one-minute budget for all API requests from one signed-in user. 0 disables the limit.',
    kind: 'number',
    envVar: 'RATE_LIMIT_PER_MINUTE',
    envDefault: (c) => String(c.rateLimitPerMinute),
    min: 0,
    max: 10_000,
  },
  {
    key: 'limits.chat_rate_limit_per_minute',
    group: 'limits',
    label: 'Chat turns per minute (per user)',
    help: 'A separate, tighter budget for sending a chat message, which is the only request that costs a model call. The general limit alone cannot protect it — 120 cheap page loads and 120 generations are not the same load. 0 disables the limit.',
    kind: 'number',
    envVar: 'CHAT_RATE_LIMIT_PER_MINUTE',
    envDefault: (c) => String(c.chatRateLimitPerMinute),
    min: 0,
    max: 1000,
  },

  // ── Ingest ──
  {
    key: 'ingest.chunk_size',
    group: 'ingest',
    label: 'Chunk size',
    help: 'Characters per chunk when splitting a document.',
    kind: 'number',
    envVar: 'CHUNK_SIZE',
    envDefault: (c) => String(c.chunkSize),
    min: 100,
    max: 8000,
  },
  {
    key: 'ingest.chunk_overlap',
    group: 'ingest',
    label: 'Chunk overlap',
    help: 'Characters shared between adjacent chunks. Must be smaller than the chunk size.',
    kind: 'number',
    envVar: 'CHUNK_OVERLAP',
    envDefault: (c) => String(c.chunkOverlap),
    min: 0,
    max: 4000,
  },

  // ── SharePoint ──
  {
    key: 'sharepoint.tenant_hostname',
    group: 'sharepoint',
    label: 'Tenant hostname',
    help: 'e.g. contoso.sharepoint.com',
    kind: 'string',
    envVar: 'SHAREPOINT_TENANT_HOSTNAME',
    envDefault: (c) => c.sharepointHostname,
  },
  {
    key: 'sharepoint.site_path',
    group: 'sharepoint',
    label: 'Site path',
    help: 'e.g. /QA/ISOTEAM',
    kind: 'string',
    envVar: 'SHAREPOINT_SITE_PATH',
    envDefault: (c) => c.sharepointSitePath,
  },
  {
    key: 'sharepoint.registry_list_name',
    group: 'sharepoint',
    label: 'Registry list name',
    help: 'Legacy registry list, matched case-insensitively. Only read by the one-shot import-registry endpoint — the distribution_lists table is the source of truth.',
    kind: 'string',
    envVar: 'SHAREPOINT_LIST_NAME',
    envDefault: (c) => c.sharepointRegistryListName,
  },
  {
    key: 'sharepoint.incremental_window_days',
    group: 'sharepoint',
    label: 'Incremental window (days)',
    help: '0 = full sync every run. Above 0, only rows modified within this many days of the last sync are fetched; the window provides slop for clock skew.',
    kind: 'number',
    envVar: 'SHAREPOINT_REGISTRY_INCREMENTAL_WINDOW_DAYS',
    envDefault: (c) => String(c.sharepointRegistryIncrementalWindowDays),
    min: 0,
    max: 365,
  },

  // ── Users ──
  {
    key: 'users.sync_interval_days',
    group: 'users',
    label: 'Profile resync interval (days)',
    help: 'A logged-in user whose profile is older than this triggers a background job-profile re-scan.',
    kind: 'number',
    envVar: 'USER_SYNC_INTERVAL_DAYS',
    envDefault: (c) => String(c.userSyncIntervalDays),
    min: 1,
    max: 365,
  },
  {
    key: 'users.default_job_title',
    group: 'users',
    label: 'Fallback job title',
    help: "Used while a user's own profile is mid-scan or unknown. Changing it shifts which documents unknown-profile users can read.",
    kind: 'string',
    envVar: 'DEFAULT_JOB_TITLE',
    envDefault: (c) => c.rawDefaultJobTitle,
  },
  {
    key: 'users.default_department',
    group: 'users',
    label: 'Fallback department',
    help: 'Paired with the fallback job title to form the access-filter join key.',
    kind: 'string',
    envVar: 'DEFAULT_DEPARTMENT',
    envDefault: (c) => c.rawDefaultDepartment,
  },
]

export const SETTING_DEFS_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]))

/**
 * Env vars surfaced read-only in the portal. `secret: true` values are masked
 * before they leave the server — they are never sent in full.
 */
export const ENV_VIEW: { name: string; secret: boolean; note?: string }[] = [
  { name: 'NODE_ENV', secret: false },
  { name: 'CHAT_PROVIDER', secret: false, note: 'Selects the SDK client at boot. Restart to change.' },
  { name: 'OPENAI_API_BASE', secret: false },
  { name: 'OPENCODE_API_BASE', secret: false },
  { name: 'FRONTEND_URL', secret: false },
  { name: 'AZURE_CLIENT_ID', secret: false },
  { name: 'AZURE_TENANT_ID', secret: false },
  { name: 'AZURE_REDIRECT_URI', secret: false },
  { name: 'ADMIN_EMAILS', secret: false, note: 'Promotion is one-way; removing an email never demotes.' },
  { name: 'POSTGRES_HOST', secret: false },
  { name: 'POSTGRES_PORT', secret: false },
  { name: 'POSTGRES_USER', secret: false },
  { name: 'POSTGRES_DB', secret: false },
  {
    name: 'POSTGRES_POOL_MAX',
    secret: false,
    note: 'Applied when the connection pool opens. Restart to change. Must stay well under the database\'s max_connections.',
  },
  {
    name: 'PGVECTOR_EF_SEARCH',
    secret: false,
    note: 'HNSW candidate list size, set on each connection. Caps the effective retrieval candidate pool — raising the pool above this value does nothing. Restart to change.',
  },
  { name: 'REDIS_URL', secret: false },
  { name: 'OPENAI_API_KEY', secret: true },
  { name: 'OPENCODE_API_KEY', secret: true },
  { name: 'GOOGLE_GENERATIVE_AI_API_KEY', secret: true },
  { name: 'AZURE_CLIENT_SECRET', secret: true },
  { name: 'POSTGRES_PASSWORD', secret: true },
  { name: 'SESSION_SECRET', secret: true },
]

/**
 * Reveal enough of a secret to recognise which credential is loaded, never
 * enough to use it. Short values are masked entirely rather than mostly shown.
 */
export function maskSecret(value: string | undefined): string | null {
  if (!value) return null
  if (value.length <= 12) return '••••••••'
  return `${value.slice(0, 3)}••••${value.slice(-4)}`
}

/**
 * Strip userinfo from a connection URL: `redis://user:pw@host:6379` becomes
 * `redis://••••@host:6379`. REDIS_URL is shown unmasked so an admin can confirm
 * the host, but it may carry a password in prod.
 */
export function redactUrlCredentials(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/:\/\/[^@/]+@/, '://••••@')
}
