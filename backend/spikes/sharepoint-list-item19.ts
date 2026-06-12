/**
 * Targeted re-probe of item #19 (QC-SDC.01) — user-confirmed accessible.
 * Goal: distinguish "DocId service is broken" from "user can't see source library".
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

const TENANT = 'saigontechnology0.sharepoint.com'
const SITE_PATH = '/SDC/ISOSDC'
const LIST = 'Danh mục total SDC'
const ITEM_ID = '19'

@Module({ imports: [AppConfigModule, PrismaModule, AuthModule] })
class M {}

function line(s: string) { console.log('\n── ' + s + ' ──') }

const app = await NestFactory.createApplicationContext(M, { logger: ['error', 'warn'] })
const prisma = app.get(PrismaService)
const sessions = app.get(SessionService)
const config = app.get(AppConfig)

const session = await prisma.session.findFirst({ where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
if (!session) { console.error('no session'); await app.close(); process.exit(2) }
const gToken = await sessions.getGraphToken(session)

// SP-audience token
const sink = { data: session.tokenCache as string | null }
const cca = new ConfidentialClientApplication({
  auth: { clientId: config.azureClientId, authority: `https://login.microsoftonline.com/${config.azureTenantId}`, clientSecret: config.azureClientSecret },
  cache: { cachePlugin: {
    beforeCacheAccess: async (c) => { if (sink.data) c.tokenCache.deserialize(sink.data) },
    afterCacheAccess: async (c) => { if (c.cacheHasChanged) sink.data = c.tokenCache.serialize() },
  }},
})
const acct = (await cca.getTokenCache().getAllAccounts())[0]
const spTokenRes = await cca.acquireTokenSilent({ account: acct, scopes: [`https://${TENANT}/.default`] })
const spToken = spTokenRes!.accessToken

async function g(path: string): Promise<any> {
  const r = await fetch(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`,
    { headers: { Authorization: `Bearer ${gToken}` } })
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} :: ${(await r.text()).slice(0, 300)}`)
  return r.json()
}

// 1. Pull row 19 directly
line('1. Pull item #19 from the list')
const site = await g(`/sites/${TENANT}:${SITE_PATH}`)
const lists = await g(`/sites/${site.id}/lists?$filter=displayName eq '${encodeURIComponent(LIST)}'`)
const listId = lists.value[0].id
const row = await g(`/sites/${site.id}/lists/${listId}/items/${ITEM_ID}?$expand=fields`)
const f = row.fields
console.log(`Code=${f.Code}  Ver=${f.Ver}  Title=${f.Title}`)
const linkUrl = (f.Link && typeof f.Link === 'object' && 'Url' in f.Link) ? f.Link.Url : f.Link
console.log(`Link.Url=${linkUrl}`)
const docId = (linkUrl?.match(/[?&]ID=([^&]+)/i) ?? [])[1]
console.log(`DocId=${docId}`)

// 2. Plain-text Graph Search for the Code — does the file even appear in this user's search index?
line('2. Plain-text search for the Code (sanity: file in user\'s index?)')
const searchByCode = await (await fetch('https://graph.microsoft.com/v1.0/search/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${gToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ requests: [{ entityTypes: ['driveItem'], query: { queryString: `"${f.Code}"` }, fields: ['name','webUrl','parentReference','eTag'], from: 0, size: 5 }] }),
})).json() as any
const codeHits = searchByCode?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
console.log(`hits = ${codeHits.length}`)
codeHits.slice(0, 5).forEach((h: any, i: number) => {
  const r = h.resource
  console.log(`  [${i}] ${r?.name}`)
  console.log(`        ${r?.webUrl}`)
})

// 3. SP REST search DocId (already tried; re-run for this specific row to confirm)
line('3. SP REST search by DocId (this exact row)')
const url = `https://${TENANT}${SITE_PATH}/_api/search/query?querytext='DocId:${encodeURIComponent(docId)}'&selectproperties='Path,Title,UniqueId,SiteId,WebId,FileType'&rowlimit=5`
const r3 = await fetch(url, { headers: { Authorization: `Bearer ${spToken}`, Accept: 'application/json;odata=nometadata' } })
console.log(`status=${r3.status}`)
if (r3.ok) {
  const j: any = await r3.json()
  const rows = j?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? []
  console.log(`rows=${rows.length}`)
  rows.slice(0, 3).forEach((rw: any) => {
    const c: Record<string,string> = {}; for (const cell of rw.Cells ?? []) c[cell.Key] = cell.Value
    console.log(`  Path=${c.Path}  Title=${c.Title}`)
  })
}

// 4. SP REST search by Code as filename/title — alternate approach for THIS row
line('4. SP REST search by Code (filename match)')
for (const q of [`Title:"${f.Code}"`, `Filename:"${f.Code}"`, `"${f.Code}"`]) {
  const u = `https://${TENANT}${SITE_PATH}/_api/search/query?querytext=${encodeURIComponent(q)}&selectproperties='Path,Title,FileType'&rowlimit=3`
  const r = await fetch(u, { headers: { Authorization: `Bearer ${spToken}`, Accept: 'application/json;odata=nometadata' } })
  const j: any = await r.json()
  const rows = j?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? []
  console.log(`  query=${q.padEnd(28)}  hits=${rows.length}`)
  rows.slice(0, 2).forEach((rw: any) => {
    const c: Record<string,string> = {}; for (const cell of rw.Cells ?? []) c[cell.Key] = cell.Value
    console.log(`     - ${c.Path}`)
  })
}

// 5. Try Graph /shares/ with the DocIdRedir URL (already tried; included for completeness)
line('5. Graph /shares/u!<b64(linkUrl)>/driveItem')
const b64 = Buffer.from(linkUrl, 'utf-8').toString('base64').replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')
try {
  const di = await g(`/shares/u!${b64}/driveItem`)
  console.log(`✓ name=${di.name}  id=${di.id}  driveId=${di.parentReference?.driveId}`)
} catch (e) { console.log(`✗ ${(e as Error).message.split('\n')[0]}`) }

// 6. Does the user have read access to the SDC site (where the file likely lives)?
line('6. Check user access to /SDC root site (where item 19 file lives)')
try {
  const sdcSite = await g(`/sites/${TENANT}:/SDC`)
  console.log(`✓ ${sdcSite.displayName}  id=${sdcSite.id.slice(0,40)}...`)
} catch (e) { console.log(`✗ ${(e as Error).message.split('\n')[0]}`) }

await app.close()
