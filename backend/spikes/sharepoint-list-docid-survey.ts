/**
 * Tiny diagnostic: pull every row in "Danh mục total SDC", parse each
 * Link's DocId, and probe SP REST search for each. Tells us whether the
 * DocId mechanism is dead tenant-wide or only for specific rows.
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { AppConfigModule } from '../src/config/config.module.js'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { AuthModule } from '../src/auth/auth.module.js'
import { SessionService } from '../src/auth/session.service.js'
import { AppConfig } from '../src/config/app-config.service.js'

const TENANT_HOSTNAME = 'saigontechnology0.sharepoint.com'
const SITE_PATH = '/SDC/ISOSDC'
const LIST_NAME = 'Danh mục total SDC'

@Module({ imports: [AppConfigModule, PrismaModule, AuthModule] })
class M {}

const app = await NestFactory.createApplicationContext(M, { logger: ['error', 'warn'] })
const prisma = app.get(PrismaService)
const sessions = app.get(SessionService)
const config = app.get(AppConfig)

const session = await prisma.session.findFirst({ where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
if (!session) { console.error('no session'); await app.close(); process.exit(2) }

const graphToken = await sessions.getGraphToken(session)

// SP token
const sink = { data: session.tokenCache as string | null }
const cca = new ConfidentialClientApplication({
  auth: { clientId: config.azureClientId, authority: `https://login.microsoftonline.com/${config.azureTenantId}`, clientSecret: config.azureClientSecret },
  cache: { cachePlugin: {
    beforeCacheAccess: async (c) => { if (sink.data) c.tokenCache.deserialize(sink.data) },
    afterCacheAccess: async (c) => { if (c.cacheHasChanged) sink.data = c.tokenCache.serialize() },
  }},
})
const acct = (await cca.getTokenCache().getAllAccounts())[0]
const spTokenResult = await cca.acquireTokenSilent({ account: acct, scopes: [`https://${TENANT_HOSTNAME}/.default`] })
const spToken = spTokenResult!.accessToken

// Site + list ids
const site = await (await fetch(`https://graph.microsoft.com/v1.0/sites/${TENANT_HOSTNAME}:${SITE_PATH}`,
  { headers: { Authorization: `Bearer ${graphToken}` } })).json() as any
const lists = await (await fetch(`https://graph.microsoft.com/v1.0/sites/${site.id}/lists?$filter=displayName eq '${encodeURIComponent(LIST_NAME)}'`,
  { headers: { Authorization: `Bearer ${graphToken}` } })).json() as any
const listId = lists.value[0].id

// All rows
const items: any[] = []
let next: string | null = `https://graph.microsoft.com/v1.0/sites/${site.id}/lists/${listId}/items?$expand=fields&$top=200`
while (next) {
  const r = await (await fetch(next, { headers: { Authorization: `Bearer ${graphToken}` } })).json() as any
  items.push(...(r.value ?? []))
  next = r['@odata.nextLink'] ?? null
}
console.log(`Total list rows: ${items.length}`)
console.log('')

function parseDoc(u?: string): string | null {
  if (!u) return null
  const m = u.match(/[?&]ID=([^&]+)/i)
  return m ? decodeURIComponent(m[1]) : null
}

let resolvable = 0, dead = 0, malformed = 0
const dataPoints: string[] = []
for (const it of items.slice(0, 20)) { // cap at 20 for speed
  const f = it.fields ?? {}
  const link = (f.Link && typeof f.Link === 'object' && 'Url' in f.Link) ? (f.Link as any).Url : f.Link
  const docId = parseDoc(link)
  if (!docId) {
    malformed++
    dataPoints.push(`#${it.id} ${f.Code ?? '?'} v${f.Ver ?? '?'}  NO_DOCID  link=${JSON.stringify(link).slice(0, 80)}`)
    continue
  }
  // SP REST search
  const url = `https://${TENANT_HOSTNAME}${SITE_PATH}/_api/search/query?querytext='DocId:${encodeURIComponent(docId)}'&selectproperties='Path,Title'&rowlimit=1`
  let hitCount = 0; let path = ''
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${spToken}`, Accept: 'application/json;odata=nometadata' } })
    if (r.ok) {
      const j: any = await r.json()
      const rows = j?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? []
      hitCount = rows.length
      if (hitCount) {
        const cells: Record<string, string> = {}
        for (const c of rows[0].Cells ?? []) cells[c.Key] = c.Value
        path = cells.Path ?? ''
      }
    }
  } catch {}
  if (hitCount) { resolvable++; dataPoints.push(`#${it.id} ${f.Code ?? '?'} v${f.Ver ?? '?'}  ✓ ${docId.slice(0, 30)}  → ${path.slice(0, 90)}`) }
  else          { dead++;       dataPoints.push(`#${it.id} ${f.Code ?? '?'} v${f.Ver ?? '?'}  ✗ ${docId.slice(0, 30)}  (no SP search hits)`) }
}

console.log(`Probed first ${Math.min(20, items.length)} rows:`)
for (const d of dataPoints) console.log('  ' + d)
console.log(`\nResolvable: ${resolvable}   Dead: ${dead}   Malformed: ${malformed}`)

await app.close()
