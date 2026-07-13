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
  /** Optional Host-header override. Undefined when the env var is unset/empty. */
  get openaiHostOverride(): string | undefined {
    const v = this.raw.get<string>('OPENAI_HOST_OVERRIDE')
    return v && v.length ? v : undefined
  }
  get chatModel()     { return this.raw.getOrThrow('CHAT_MODEL') }
  get embeddingModel(){ return this.raw.getOrThrow('EMBEDDING_MODEL') }
  get chatMaxSteps(): number { return this.raw.getOrThrow('CHAT_MAX_STEPS') }

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
