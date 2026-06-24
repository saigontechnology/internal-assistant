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

  // ── SharePoint List watcher ──
  get sharepointHostname() { return this.raw.getOrThrow('SHAREPOINT_TENANT_HOSTNAME') }
  get sharepointSitePath() { return this.raw.getOrThrow('SHAREPOINT_SITE_PATH') }
  get sharepointListName() { return this.raw.getOrThrow('SHAREPOINT_LIST_NAME') }

  // ── Per-user sync ──
  get userSyncIntervalDays(): number { return this.raw.getOrThrow('USER_SYNC_INTERVAL_DAYS') }
  /** Normalized fallback profile tuple — used when a user's own profile isn't ready. */
  get defaultProfile(): { jobTitle: string; department: string } {
    return {
      jobTitle: normalizeProfileField(this.raw.getOrThrow('DEFAULT_JOB_TITLE')),
      department: normalizeProfileField(this.raw.getOrThrow('DEFAULT_DEPARTMENT')),
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
