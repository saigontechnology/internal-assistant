/**
 * Compose the Postgres connection URL from POSTGRES_* env vars.
 *
 * The URL is intentionally NOT stored as an env var so the same configuration
 * works in dev (POSTGRES_HOST=localhost), inside docker compose
 * (POSTGRES_HOST=postgres), and any future environment without rewriting
 * connection strings in multiple places.
 */
export interface PostgresEnv {
  POSTGRES_HOST?: string
  POSTGRES_PORT?: string | number
  POSTGRES_USER?: string
  POSTGRES_PASSWORD?: string
  POSTGRES_DB?: string
}

export function buildDatabaseUrl(env: PostgresEnv = process.env as PostgresEnv): string {
  const host = env.POSTGRES_HOST
  const port = env.POSTGRES_PORT
  const user = env.POSTGRES_USER
  const password = env.POSTGRES_PASSWORD
  const db = env.POSTGRES_DB
  const missing: string[] = []
  if (!host) missing.push('POSTGRES_HOST')
  if (!port) missing.push('POSTGRES_PORT')
  if (!user) missing.push('POSTGRES_USER')
  if (!password) missing.push('POSTGRES_PASSWORD')
  if (!db) missing.push('POSTGRES_DB')
  if (missing.length) {
    throw new Error(`Cannot build DATABASE_URL — missing env vars: ${missing.join(', ')}`)
  }
  // URL-encode user/password in case they contain special characters.
  return `postgres://${encodeURIComponent(user!)}:${encodeURIComponent(password!)}@${host}:${port}/${db}`
}
