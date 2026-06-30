import 'dotenv/config'
import { createRequire } from 'node:module'
import { PrismaPg } from '@prisma/adapter-pg'
import { buildDatabaseUrl } from '../src/config/database-url.js'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client')

/**
 * Wipe all sync/index data so the new multi-list watcher can rebuild from
 * scratch. Clears, in FK-safe order:
 *
 *   embeddings                     — depend on resources
 *   distribution_list_items        — per-doc distribution-list intent, if present
 *   resources                      — the indexed corpus
 *   watcher_state                  — per-list sync bookkeeping
 *   job_profile_distribution_lists — (jobProfile, distributionList) edges, if present
 *   job_profile_access             — (jobProfile, code) edges; depends on job_profiles
 *   distribution_lists             — registry-driven distribution list rows, if present
 *   job_profiles                   — per-profile sync state + locks
 *   user_permissions               — per-user lastSync + profile cache
 *
 * Preserves: sessions, sync_allowlist, chat_histories. Pass --include-chat
 * to also drop chat history.
 *
 * Usage:
 *   npx tsx scripts/reset-sync-data.ts          # dry-run, prints counts
 *   npx tsx scripts/reset-sync-data.ts --yes    # actually delete
 *   npx tsx scripts/reset-sync-data.ts --yes --include-chat
 */

const OPTIONAL_TABLES = [
  'distribution_list_items',
  'job_profile_distribution_lists',
  'distribution_lists',
] as const

type OptionalTable = (typeof OPTIONAL_TABLES)[number]

type RawExecutor = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const confirmed = args.has('--yes') || args.has('-y')
  const includeChat = args.has('--include-chat')

  const connectionString = buildDatabaseUrl({
    POSTGRES_HOST: required('POSTGRES_HOST'),
    POSTGRES_PORT: required('POSTGRES_PORT'),
    POSTGRES_USER: required('POSTGRES_USER'),
    POSTGRES_PASSWORD: required('POSTGRES_PASSWORD'),
    POSTGRES_DB: required('POSTGRES_DB'),
  })
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  const optionalTables = await getExistingOptionalTables(prisma)

  const counts = {
    embeddings: await prisma.embedding.count(),
    distributionListItems: await countOptionalTable(prisma, optionalTables, 'distribution_list_items'),
    resources: await prisma.resource.count(),
    watcherState: await prisma.watcherState.count(),
    jobProfileDistributionLists: await countOptionalTable(
      prisma,
      optionalTables,
      'job_profile_distribution_lists',
    ),
    jobProfileAccess: await prisma.jobProfileAccess.count(),
    distributionLists: await countOptionalTable(prisma, optionalTables, 'distribution_lists'),
    jobProfiles: await prisma.jobProfile.count(),
    userPermissions: await prisma.userPermission.count(),
    chatHistories: includeChat ? await prisma.chatHistory.count() : undefined,
  }

  console.log('Current row counts:')
  for (const [k, v] of Object.entries(counts)) {
    if (v !== undefined) console.log(`  ${k.padEnd(20)} ${v}`)
  }

  if (!confirmed) {
    console.log('\nDry-run only — pass --yes to actually delete.')
    await prisma.$disconnect()
    return
  }

  // FK-safe order: leaf tables first.
  await prisma.$transaction(async (tx) => {
    if (includeChat) {
      await tx.chatHistory.deleteMany({})
    }
    await tx.embedding.deleteMany({})
    await deleteOptionalTable(tx, optionalTables, 'distribution_list_items')
    await tx.resource.deleteMany({})
    await tx.watcherState.deleteMany({})
    await deleteOptionalTable(tx, optionalTables, 'job_profile_distribution_lists')
    await tx.jobProfileAccess.deleteMany({})
    await deleteOptionalTable(tx, optionalTables, 'distribution_lists')
    await tx.jobProfile.deleteMany({})
    await tx.userPermission.deleteMany({})
  })

  console.log('\nDone. All sync/index tables cleared.')
  await prisma.$disconnect()
}

async function getExistingOptionalTables(db: RawExecutor): Promise<Set<OptionalTable>> {
  const rows = await db.$queryRawUnsafe<{ table_name: OptionalTable }[]>(
    `
      SELECT table_name::text AS table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [...OPTIONAL_TABLES],
  )

  return new Set(rows.map((row) => row.table_name))
}

async function countOptionalTable(
  db: RawExecutor,
  existingTables: Set<OptionalTable>,
  tableName: OptionalTable,
): Promise<number | undefined> {
  if (!existingTables.has(tableName)) return undefined

  const rows = await db.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*)::int AS count FROM "${tableName}"`,
  )
  return rows[0]?.count ?? 0
}

async function deleteOptionalTable(
  db: RawExecutor,
  existingTables: Set<OptionalTable>,
  tableName: OptionalTable,
): Promise<void> {
  if (!existingTables.has(tableName)) return

  await db.$executeRawUnsafe(`DELETE FROM "${tableName}"`)
}

function required(key: string): string {
  const v = process.env[key]
  if (!v || v.length === 0) throw new Error(`Missing env var: ${key}`)
  return v
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
