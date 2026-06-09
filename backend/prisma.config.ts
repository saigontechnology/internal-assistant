// Prisma 7 CLI config — `prisma migrate`, `prisma db pull`, etc. resolve
// the connection string from here instead of `datasource db { url = ... }`
// (the old in-schema form was dropped in Prisma 7).
//
// The URL is composed from POSTGRES_* env vars rather than read as
// DATABASE_URL — keeps a single source of truth shared with the runtime
// app and the docker-compose setup.
//
// Runtime connections (PrismaClient inside the Nest app) use the PrismaPg
// adapter defined in src/prisma/prisma.service.ts — this file is CLI-only.
import 'dotenv/config'
import { defineConfig } from 'prisma/config'
import { buildDatabaseUrl } from './src/config/database-url.js'

const url = buildDatabaseUrl()
// `prisma migrate diff` against a migrations directory needs a shadow DB on
// the same instance. Default to a `_shadow`-suffixed sibling so it's
// predictable without extra config; override via SHADOW_DATABASE_URL.
const shadowDatabaseUrl =
  process.env.SHADOW_DATABASE_URL ?? url.replace(/\/([^/?]+)(\?|$)/, '/$1_shadow$2')

export default defineConfig({
  schema: './prisma/schema.prisma',
  migrations: {
    path: './prisma/migrations',
  },
  datasource: {
    url,
    shadowDatabaseUrl,
  },
})
