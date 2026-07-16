import { ConfigService } from '@nestjs/config'
import type { Env } from './env.schema.js'
import { buildDatabaseUrl } from './database-url.js'

/**
 * Typed wrapper around @nestjs/config so callers get autocomplete + compile
 * errors when env vars are renamed, instead of stringly-typed getters.
 *
 * Plain class (no @Injectable) — wired in app.module.ts via a factory provider
 * so DI works under tsx/esbuild without `emitDecoratorMetadata`.
 */
export class AppConfig {
  constructor(private readonly raw: ConfigService<Env, true>) {}

  // ── LLM ──
  get openaiApiBase() { return this.raw.getOrThrow('OPENAI_API_BASE') }
  get openaiApiKey()  { return this.raw.getOrThrow('OPENAI_API_KEY') }
  get chatModel()     { return this.raw.getOrThrow('CHAT_MODEL') }
  get embeddingModel(){ return this.raw.getOrThrow('EMBEDDING_MODEL') }
  get chatMaxSteps(): number { return this.raw.getOrThrow('CHAT_MAX_STEPS') }
  get chatHistoryWindow(): number { return this.raw.getOrThrow('CHAT_HISTORY_WINDOW') }
  get chatHistoryMaxPersisted(): number { return this.raw.getOrThrow('CHAT_HISTORY_MAX_PERSISTED') }

  // ── Retrieval ──
  get retrievalTopK(): number         { return this.raw.getOrThrow('RETRIEVAL_TOP_K') }
  get retrievalMaxPerDoc(): number    { return this.raw.getOrThrow('RETRIEVAL_MAX_PER_DOC') }
  get retrievalCandidatePool(): number { return this.raw.getOrThrow('RETRIEVAL_CANDIDATE_POOL') }

  // ── Outbound provider limits ──
  get llmMaxRetries(): number        { return this.raw.getOrThrow('LLM_MAX_RETRIES') }
  get embeddingConcurrency(): number { return this.raw.getOrThrow('EMBEDDING_CONCURRENCY') }
  get chatConcurrency(): number      { return this.raw.getOrThrow('CHAT_CONCURRENCY') }

  // ── Rate limiting ──
  get rateLimitPerMinute(): number     { return this.raw.getOrThrow('RATE_LIMIT_PER_MINUTE') }
  get chatRateLimitPerMinute(): number { return this.raw.getOrThrow('CHAT_RATE_LIMIT_PER_MINUTE') }

  /** How long SIGTERM waits for in-flight chat streams before aborting them. */
  get shutdownDrainTimeoutMs(): number { return this.raw.getOrThrow('SHUTDOWN_DRAIN_TIMEOUT_MS') }

  // ── Chat provider switch (OpenRouter ↔ Gemini ↔ OpenCode) ──
  get chatProvider(): 'openai' | 'gemini' | 'opencode' { return this.raw.getOrThrow('CHAT_PROVIDER') }
  get googleApiKey(): string | undefined {
    const v = this.raw.get<string>('GOOGLE_GENERATIVE_AI_API_KEY')
    return v && v.length ? v : undefined
  }
  get geminiChatModel()               { return this.raw.getOrThrow('GEMINI_CHAT_MODEL') }
  get geminiChatFallbackModel()       { return this.raw.getOrThrow('GEMINI_CHAT_FALLBACK_MODEL') }
  get geminiChatSecondFallbackModel() { return this.raw.getOrThrow('GEMINI_CHAT_SECOND_FALLBACK_MODEL') }

  // ── OpenCode gateway (chat only) ──
  get opencodeApiBase() { return this.raw.getOrThrow('OPENCODE_API_BASE') }
  get opencodeApiKey(): string | undefined {
    const v = this.raw.get<string>('OPENCODE_API_KEY')
    return v && v.length ? v : undefined
  }
  get opencodeChatModel()               { return this.raw.getOrThrow('OPENCODE_CHAT_MODEL') }
  get opencodeChatFallbackModel()       { return this.raw.getOrThrow('OPENCODE_CHAT_FALLBACK_MODEL') }
  get opencodeChatSecondFallbackModel() { return this.raw.getOrThrow('OPENCODE_CHAT_SECOND_FALLBACK_MODEL') }
  get chunkSize()     { return this.raw.getOrThrow('CHUNK_SIZE') }
  get chunkOverlap()  { return this.raw.getOrThrow('CHUNK_OVERLAP') }

  // ── Postgres ──
  get databaseUrl() {
    return buildDatabaseUrl({
      POSTGRES_HOST: this.raw.getOrThrow('POSTGRES_HOST'),
      POSTGRES_PORT: this.raw.getOrThrow('POSTGRES_PORT'),
      POSTGRES_USER: this.raw.getOrThrow('POSTGRES_USER'),
      POSTGRES_PASSWORD: this.raw.getOrThrow('POSTGRES_PASSWORD'),
      POSTGRES_DB: this.raw.getOrThrow('POSTGRES_DB'),
    })
  }
  get poolMax(): number                 { return this.raw.getOrThrow('POSTGRES_POOL_MAX') }
  get poolIdleTimeoutMs(): number       { return this.raw.getOrThrow('POSTGRES_POOL_IDLE_TIMEOUT_MS') }
  get poolConnectionTimeoutMs(): number { return this.raw.getOrThrow('POSTGRES_POOL_CONNECTION_TIMEOUT_MS') }
  get statementTimeoutMs(): number      { return this.raw.getOrThrow('POSTGRES_STATEMENT_TIMEOUT_MS') }
  get pgvectorEfSearch(): number        { return this.raw.getOrThrow('PGVECTOR_EF_SEARCH') }

  // ── Azure / MSAL ──
  get azureClientId()     { return this.raw.getOrThrow('AZURE_CLIENT_ID') }
  get azureTenantId()     { return this.raw.getOrThrow('AZURE_TENANT_ID') }
  get azureClientSecret() { return this.raw.getOrThrow('AZURE_CLIENT_SECRET') }
  get azureRedirectUri()  { return this.raw.getOrThrow('AZURE_REDIRECT_URI') }

  // ── App ──
  get frontendUrl()    { return this.raw.getOrThrow('FRONTEND_URL') }
  get sessionSecret()  { return this.raw.getOrThrow('SESSION_SECRET') }
  get isProd()         { return this.raw.getOrThrow('NODE_ENV') === 'production' }

  // ── Admin portal ──
  /**
   * Bootstrap admins, normalized to lowercase. These emails are promoted to
   * role='admin' at boot and on every login; the promotion is one-way, so an
   * admin granted through the portal survives being dropped from this list.
   */
  get adminEmails(): string[] {
    return this.raw
      .getOrThrow<string>('ADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim().toLocaleLowerCase())
      .filter((e) => e.length > 0)
  }

  // ── Redis (resumable chat streams) ──
  get redisUrl() { return this.raw.getOrThrow('REDIS_URL') }

  // ── SharePoint List watcher ──
  get sharepointHostname() { return this.raw.getOrThrow('SHAREPOINT_TENANT_HOSTNAME') }
  get sharepointSitePath() { return this.raw.getOrThrow('SHAREPOINT_SITE_PATH') }
  /**
   * Name of the legacy registry list (case-insensitive match). No longer read
   * by the watcher — the DB owns distribution lists now. Only the one-shot
   * `POST /api/admin/distribution-lists/import-registry` endpoint uses this.
   */
  get sharepointRegistryListName() { return this.raw.getOrThrow('SHAREPOINT_LIST_NAME') }
  /** Days of slop for incremental sync (0 = full sync). */
  get sharepointRegistryIncrementalWindowDays(): number {
    return this.raw.getOrThrow('SHAREPOINT_REGISTRY_INCREMENTAL_WINDOW_DAYS')
  }

  // ── Per-user sync ──
  get userSyncIntervalDays(): number { return this.raw.getOrThrow('USER_SYNC_INTERVAL_DAYS') }
  /** Un-normalized env values, for display in the admin settings form. */
  get rawDefaultJobTitle(): string { return this.raw.getOrThrow('DEFAULT_JOB_TITLE') }
  get rawDefaultDepartment(): string { return this.raw.getOrThrow('DEFAULT_DEPARTMENT') }
  /** Normalized fallback profile tuple — used when a user's own profile isn't ready. */
  get defaultProfile(): { jobTitle: string; department: string } {
    return {
      jobTitle: normalizeProfileField(this.rawDefaultJobTitle),
      department: normalizeProfileField(this.rawDefaultDepartment),
    }
  }
}

/** Shared normalization for jobTitle / department fields (storage + lookup). */
export function normalizeProfileField(v: string | null | undefined): string {
  const s = (v ?? '').trim().toLocaleLowerCase()
  return s.length === 0 ? '__unassigned__' : s
}

/**
 * Microsoft Graph delegated scopes requested during sign-in. MSAL adds the
 * reserved openid/profile/offline_access scopes automatically.
 */
export const graphScopes = ['Sites.Read.All', 'Files.Read.All', 'User.Read']
