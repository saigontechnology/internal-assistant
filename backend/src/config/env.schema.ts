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

  // Optional. When set, sent as the `Host` header on every outbound OpenAI
  // request. Workaround for upstream proxies that gate on Host (e.g. our
  // 9router instance on the VPS returns 401 unless Host is 127.0.0.1:20128).
  // Leave empty in local dev when 9router is reached directly.
  OPENAI_HOST_OVERRIDE: z.string().optional(),

  // SharePoint List watcher (Phase A). Resolved at sync time and cached in-process.
  SHAREPOINT_TENANT_HOSTNAME: z.string().min(1).default('saigontechnology0.sharepoint.com'),
  SHAREPOINT_SITE_PATH: z.string().min(1).default('/SDC/ISOSDC'),
  SHAREPOINT_LIST_NAME: z.string().min(1).default('Danh mục total SDC'),
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
