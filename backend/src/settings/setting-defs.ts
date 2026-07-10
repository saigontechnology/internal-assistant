import { AppConfig } from '../config/app-config.service.js'

/**
 * The settings an admin may change at runtime, and the env var each one falls
 * back to. This registry is the single source of truth: it drives validation
 * in the controller, the reset surface, and the rendered admin form.
 *
 * Deliberately absent, and why:
 *
 * - `EMBEDDING_MODEL` — the `embedding` column is `halfvec(2048)` with a
 *   hand-written HNSW index. A model with a different output dimension would
 *   not error; it would write vectors from another embedding space into the
 *   same column and silently corrupt retrieval until the corpus was re-embedded.
 *   That's a migration, not a setting.
 * - `CHAT_PROVIDER`, `OPENAI_API_BASE`, `OPENCODE_API_BASE`,
 *   `OPENAI_HOST_OVERRIDE` — consumed when ChatService builds its SDK clients
 *   in the constructor. An editable field that needs a restart to take effect
 *   is worse than no field.
 * - Every secret and every Postgres/Redis/Azure/session var — storing these in
 *   `app_settings` would put plaintext credentials in the database and render
 *   them into an admin page.
 * - `opencode.*` — owned by ChatSettingsService and edited at /admin/chat-model,
 *   which validates model ids against the live gateway catalog. Keys here and
 *   there are disjoint on purpose.
 */
export type SettingGroup = 'chat' | 'ingest' | 'sharepoint' | 'users'

export const SETTING_GROUPS: { group: SettingGroup; title: string; blurb: string }[] = [
  {
    group: 'chat',
    title: 'Chat models',
    blurb:
      'Used only when CHAT_PROVIDER selects them. The OpenCode ladder lives on the Chat model page.',
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
  {
    name: 'EMBEDDING_MODEL',
    secret: false,
    note: 'Not editable: a different output dimension would corrupt the pgvector column and HNSW index. Changing it requires re-embedding the corpus.',
  },
  { name: 'OPENAI_API_BASE', secret: false },
  { name: 'OPENAI_HOST_OVERRIDE', secret: false },
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
