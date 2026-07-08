import { z } from 'zod'

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

  // Chat provider switch for the staged OpenAI → Gemini migration. Only
  // affects the chat/generation path; the embedding pipeline stays on
  // OpenAI regardless. See docs/gemini-migration-plan.md.
  CHAT_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
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
  CHUNK_SIZE: z.coerce.number().default(1000),
  CHUNK_OVERLAP: z.coerce.number().default(200),

  POSTGRES_HOST: z.string().min(1, 'POSTGRES_HOST is required'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_USER: z.string().min(1, 'POSTGRES_USER is required'),
  POSTGRES_PASSWORD: z.string().min(1, 'POSTGRES_PASSWORD is required'),
  POSTGRES_DB: z.string().min(1, 'POSTGRES_DB is required'),

  AZURE_CLIENT_ID: z.string().min(1, 'AZURE_CLIENT_ID is required'),
  AZURE_TENANT_ID: z.string().min(1, 'AZURE_TENANT_ID is required'),
  AZURE_CLIENT_SECRET: z.string().min(1, 'AZURE_CLIENT_SECRET is required'),
  AZURE_REDIRECT_URI: z.string().default('http://localhost:5173/api/auth/callback'),

  FRONTEND_URL: z.string().default('http://localhost:5173'),
  SESSION_SECRET: z.string().min(1).default('dev-insecure-secret-change-me'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),

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
