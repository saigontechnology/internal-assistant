/**
 * SharePoint List Watcher — Spikes S1 + S2
 *
 * Goal:
 *   S2: Confirm column internal names for the "Danh mục total SDC" list.
 *   S1: Resolve a SharePoint DocId from the Link column → Graph driveItem.
 *
 * Runs against the freshest valid session in the DB — sign in via the
 * browser first if no session is present (or all sessions are expired).
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppConfigModule } from '../src/config/config.module.js'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { AuthModule } from '../src/auth/auth.module.js'
import { SessionService } from '../src/auth/session.service.js'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { AppConfig } from '../src/config/app-config.service.js'

const TENANT_HOSTNAME = 'saigontechnology0.sharepoint.com'
const SITE_PATH = '/SDC/ISOSDC'
const LIST_NAME = 'Danh mục total SDC'

@Module({ imports: [AppConfigModule, PrismaModule, AuthModule] })
class SpikeModule {}

async function graphGet(token: string, path: string): Promise<any> {
  const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GET ${url} → ${res.status}\n${body.slice(0, 500)}`)
  }
  return res.json()
}

async function graphPost(token: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`POST ${path} → ${res.status}\n${errBody.slice(0, 500)}`)
  }
  return res.json()
}

function line(label: string) {
  console.log('\n' + '─'.repeat(72))
  console.log(`◆ ${label}`)
  console.log('─'.repeat(72))
}

function parseDocId(linkUrl: string | undefined): string | null {
  if (typeof linkUrl !== 'string') return null
  // SharePoint Document ID redirect: /_layouts/15/DocIdRedir.aspx?ID=<docId>
  const m = linkUrl.match(/[?&]ID=([^&]+)/i)
  return m ? decodeURIComponent(m[1]) : null
}

async function main() {
  const app = await NestFactory.createApplicationContext(SpikeModule, { logger: ['error', 'warn'] })
  const prisma = app.get(PrismaService)
  const sessions = app.get(SessionService)

  // ── 0. Get a token ──
  line('0. Get delegated Graph token from freshest session')
  const session = await prisma.session.findFirst({
    where: { expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  })
  if (!session) {
    console.error('No valid session in DB. Sign in via http://localhost:5173 then re-run.')
    await app.close(); process.exit(2)
  }
  console.log(`session: ${session.id.slice(0, 8)}…  user: ${session.username}`)

  let token: string
  try {
    token = await sessions.getGraphToken(session)
    console.log(`token acquired (len=${token.length})`)
  } catch (err) {
    console.error('Token refresh failed — session probably expired silently. Sign in again.', err)
    await app.close(); process.exit(2)
  }

  // ── 1. Resolve site ──
  line('1. Resolve site id')
  let site: any
  try {
    site = await graphGet(token, `/sites/${TENANT_HOSTNAME}:${SITE_PATH}`)
    console.log(`site.id           = ${site.id}`)
    console.log(`site.displayName  = ${site.displayName}`)
    console.log(`site.webUrl       = ${site.webUrl}`)
  } catch (err) {
    console.error((err as Error).message)
    await app.close(); process.exit(1)
  }

  // ── 2. Resolve list ──
  line('2. Resolve list id by display name')
  let list: any
  try {
    const lists = await graphGet(token,
      `/sites/${site.id}/lists?$filter=displayName eq '${encodeURIComponent(LIST_NAME)}'`)
    list = lists.value?.[0]
    if (!list) {
      console.log(`list "${LIST_NAME}" not found via $filter. Falling back to scan…`)
      const all = await graphGet(token, `/sites/${site.id}/lists?$top=100`)
      console.log('Available lists:')
      for (const l of all.value ?? []) console.log(`  - ${l.displayName}   (id=${l.id})`)
      await app.close(); process.exit(1)
    }
    console.log(`list.id          = ${list.id}`)
    console.log(`list.displayName = ${list.displayName}`)
    console.log(`list.webUrl      = ${list.webUrl}`)
  } catch (err) {
    console.error((err as Error).message)
    await app.close(); process.exit(1)
  }

  // ── 3. Spike S2: dump fields of one row ──
  line('3. Spike S2 — list one item, dump fields')
  let row: any
  try {
    const items = await graphGet(token, `/sites/${site.id}/lists/${list.id}/items?$expand=fields&$top=2`)
    row = items.value?.[0]
    if (!row) {
      console.error('list is empty — cannot probe column names')
      await app.close(); process.exit(1)
    }
    console.log(`item.id      = ${row.id}`)
    console.log(`item.webUrl  = ${row.webUrl}`)
    console.log(`item.fields keys:`)
    const fields = row.fields ?? {}
    for (const [k, v] of Object.entries(fields)) {
      const valStr = typeof v === 'string'
        ? (v.length > 80 ? v.slice(0, 80) + '…' : v)
        : JSON.stringify(v)
      console.log(`  ${k.padEnd(30)} = ${valStr}`)
    }
  } catch (err) {
    console.error((err as Error).message)
    await app.close(); process.exit(1)
  }

  // ── 4. Spike S1: resolve the DocId from the Link column ──
  line('4. Spike S1 — DocId → driveItem')
  // Try to find the "Link" field — display name in the screenshot was "Link"
  // but internal name could differ. We'll search any string field containing DocIdRedir.
  const fields = row.fields as Record<string, unknown>
  let linkFieldName: string | undefined
  let linkUrl: string | undefined
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && v.includes('DocIdRedir.aspx')) {
      linkFieldName = k; linkUrl = v; break
    }
    // Modern SP "URL" columns serialize as { Url, Description }
    if (v && typeof v === 'object' && 'Url' in (v as any) && typeof (v as any).Url === 'string'
        && (v as any).Url.includes('DocIdRedir.aspx')) {
      linkFieldName = k; linkUrl = (v as any).Url; break
    }
  }
  if (!linkUrl) {
    console.log('No DocIdRedir.aspx URL found in this row\'s fields. Inspect step 3 dump above.')
    console.log('Re-run after picking the correct field name manually.')
    await app.close(); process.exit(1)
  }
  const docId = parseDocId(linkUrl)
  console.log(`Link field   = ${linkFieldName}`)
  console.log(`Link URL     = ${linkUrl}`)
  console.log(`Parsed DocId = ${docId}`)
  if (!docId) { await app.close(); process.exit(1) }

  // Try a few KQL property names. Different tenants expose different schema.
  const strategies: { label: string; query: string }[] = [
    { label: 'A.1: DocumentId',     query: `DocumentId:"${docId}"` },
    { label: 'A.2: DocId',          query: `DocId:"${docId}"` },
    { label: 'A.3: IdentifiersId',  query: `IdentifiersId:"${docId}"` },
    { label: 'A.4: bare token',     query: `"${docId}"` },
  ]

  let s1Win: string | null = null
  for (const s of strategies) {
    console.log(`\n→ ${s.label}    KQL: ${s.query}`)
    try {
      const res = await graphPost(token, '/search/query', {
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: s.query },
          fields: ['id', 'name', 'parentReference', 'eTag', 'webUrl'],
          from: 0,
          size: 5,
        }],
      })
      const hits = res?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
      console.log(`   hits = ${hits.length}`)
      hits.slice(0, 3).forEach((h: any, i: number) => {
        const r = h.resource ?? {}
        console.log(`   [${i}] name=${r.name} id=${r.id} driveId=${r.parentReference?.driveId} eTag=${r.eTag}`)
        console.log(`        webUrl=${r.webUrl}`)
      })
      if (hits.length) { s1Win = s.label; break }
    } catch (err) {
      console.log(`   error: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  if (s1Win) {
    console.log(`\n✓ STRATEGY ${s1Win.split(':')[0]} WORKS — recordable in plan §3.`)
    await app.close(); return
  }

  // ── 5. Diagnostics: figure out WHY S1 missed ──
  line('5. Diagnostics — KQL property miss vs. permission miss vs. index lag')

  console.log('\n5a. Sanity: does Graph Search work at all for this user (plain-text title)?')
  const title = String(fields.Title ?? '').trim()
  if (title) {
    try {
      const res = await graphPost(token, '/search/query', {
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: `"${title}"` },
          from: 0, size: 5,
        }],
      })
      const hits = res?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
      console.log(`   title="${title}"  hits=${hits.length}`)
      hits.slice(0, 3).forEach((h: any, i: number) => {
        const r = h.resource ?? {}
        console.log(`   [${i}] name=${r.name}  webUrl=${r.webUrl}`)
      })
      if (hits.length === 0) {
        console.log('   → Search returns NOTHING for the title either. Likely index lag or user-perm-filtered.')
      } else {
        const inCom = hits.some((h: any) => /\/COM\/ISOCOM\//i.test(h.resource?.webUrl ?? ''))
        console.log(`   → Search works; the matching file lives in /COM/ISOCOM: ${inCom ? 'YES' : 'NO'}`)
        if (!inCom) console.log('     Means: KQL DocId property is the wrong name, but Search itself sees the user\'s files.')
        else        console.log('     Means: DocId KQL property is wrong. Try other property names (see §3 spike notes).')
      }
    } catch (err) {
      console.log(`   error: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  console.log('\n5b. Does the signed-in user have read access to /COM/ISOCOM?')
  try {
    const otherSite = await graphGet(token, '/sites/saigontechnology0.sharepoint.com:/COM/ISOCOM')
    console.log(`   ✓ user CAN see /COM/ISOCOM (site.id=${otherSite.id.slice(0, 40)}…)`)
    console.log('   → S1 miss is NOT a permission issue.')
  } catch (err) {
    const msg = (err as Error).message
    if (msg.includes('403') || msg.includes('Access')) {
      console.log('   ✗ user CANNOT see /COM/ISOCOM (403). Files live in a site this user has no read on.')
      console.log('   → THIS is why Graph Search returned nothing for this user.')
      console.log('   → App-only (Phase B) with tenant-wide Sites.Read.All would solve it.')
    } else {
      console.log(`   error: ${msg.split('\n')[0]}`)
    }
  }

  console.log('\n5c. Try Path: KQL — direct webUrl lookup on the redirect target')
  // The DocIdRedir URL is the SP-side resolver; if we resolved it once, the
  // final URL would let us Path:-search. For now, just try the redirect URL.
  try {
    const res = await graphPost(token, '/search/query', {
      requests: [{
        entityTypes: ['driveItem'],
        query: { queryString: `Path:"${linkUrl}"` },
        from: 0, size: 3,
      }],
    })
    const hits = res?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
    console.log(`   hits = ${hits.length}`)
    hits.slice(0, 2).forEach((h: any) => console.log(`   - ${h.resource?.webUrl}`))
  } catch (err) {
    console.log(`   error: ${(err as Error).message.split('\n')[0]}`)
  }

  // ── Strategy D — resolve by Code (not DocId) ──
  line('Strategy D — resolve by Code/filename instead of DocId')
  const code = String(fields.Code ?? '').trim()
  const titleStr = String(fields.Title ?? '').trim()
  console.log(`Code  = ${code}`)
  console.log(`Title = ${titleStr}`)

  // The files on disk are named like:   QT-COM.01 - <Title> - v<Ver>.docx
  // and live in a folder named:         QT-COM.01 - <Title>
  // → searching for the Code as a filename token should land on the right file.
  const dStrategies: { label: string; query: string }[] = [
    { label: 'D.1: Filename:Code',   query: `Filename:"${code}"` },
    { label: 'D.2: Title:Code',      query: `Title:"${code}"` },
    { label: 'D.3: bare Code',       query: `"${code}"` },
    { label: 'D.4: Code + title',    query: `"${code}" AND "${titleStr}"` },
  ]
  let dWin: { label: string; hits: any[] } | null = null
  for (const s of dStrategies) {
    console.log(`\n→ ${s.label}    KQL: ${s.query}`)
    try {
      const res = await graphPost(token, '/search/query', {
        requests: [{
          entityTypes: ['driveItem'],
          query: { queryString: s.query },
          fields: ['id', 'name', 'parentReference', 'eTag', 'webUrl'],
          from: 0, size: 5,
        }],
      })
      const hits = res?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
      console.log(`   hits = ${hits.length}`)
      hits.slice(0, 3).forEach((h: any, i: number) => {
        const r = h.resource ?? {}
        console.log(`   [${i}] name=${r.name}`)
        console.log(`        driveId=${r.parentReference?.driveId}  itemId=${r.id}  eTag=${r.eTag}`)
      })
      // Pick the strategy whose top hit's filename actually contains the Code
      // and lives under the expected /COM/ISOCOM/ path. Filters out collisions.
      const goodHit = hits.find((h: any) => {
        const r = h.resource ?? {}
        return typeof r.name === 'string'
          && r.name.includes(code)
          && /\/COM\/ISOCOM\//i.test(r.webUrl ?? '')
      })
      if (goodHit && !dWin) {
        dWin = { label: s.label, hits }
        // keep iterating so the operator sees all strategies' results,
        // but record the first winner.
      }
    } catch (err) {
      console.log(`   error: ${(err as Error).message.split('\n')[0]}`)
    }
  }

  // ── Strategy E — /shares/u!<base64>/driveItem ──
  // The canonical Graph endpoint for resolving "any SharePoint URL" to a
  // driveItem. base64-url-encoded the URL, prefixed with "u!".
  line('Strategy E — /shares/u!<base64(linkUrl)>/driveItem (canonical SP-URL resolver)')
  const b64 = Buffer.from(linkUrl, 'utf-8').toString('base64')
    .replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')
  const sharesPath = `/shares/u!${b64}/driveItem`
  console.log(`Path: ${sharesPath}`)
  let strategyEWin = false
  try {
    const driveItem = await graphGet(token, sharesPath)
    console.log(`✓ STRATEGY E WORKS`)
    console.log(`  name        = ${driveItem.name}`)
    console.log(`  id          = ${driveItem.id}`)
    console.log(`  driveId     = ${driveItem.parentReference?.driveId}`)
    console.log(`  eTag        = ${driveItem.eTag}`)
    console.log(`  webUrl      = ${driveItem.webUrl}`)
    console.log(`  size        = ${driveItem.size}`)
    strategyEWin = true
  } catch (err) {
    console.log(`error: ${(err as Error).message.split('\n').slice(0, 4).join('\n       ')}`)
  }

  // ── Strategy F — SP-audience token from MSAL → follow DocIdRedir 302 ──
  line('Strategy F — SP-audience token → follow DocIdRedir 302 → /shares/u! on resolved URL')

  const config = app.get(AppConfig)
  // Build a one-off MSAL client seeded from the session's cache, then ask for
  // an SP-audience token. If the app reg never had SP delegated perms
  // consented, this will fail with consent_required.
  const sink = { data: session.tokenCache as string | null }
  const cca = new ConfidentialClientApplication({
    auth: {
      clientId: config.azureClientId,
      authority: `https://login.microsoftonline.com/${config.azureTenantId}`,
      clientSecret: config.azureClientSecret,
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (ctx) => { if (sink.data) ctx.tokenCache.deserialize(sink.data) },
        afterCacheAccess:  async (ctx) => { if (ctx.cacheHasChanged) sink.data = ctx.tokenCache.serialize() },
      },
    },
  })
  const account = (await cca.getTokenCache().getAllAccounts())[0]
  if (!account) {
    console.log('No account in MSAL cache — cannot try SP-audience token. Sign in again.')
    await app.close(); return
  }
  // SharePoint Online resource. `.default` asks for whatever SP scopes were consented.
  const spResource = `https://${TENANT_HOSTNAME}`
  let spToken: string
  try {
    const result = await cca.acquireTokenSilent({ account, scopes: [`${spResource}/.default`] })
    spToken = result?.accessToken ?? ''
    if (!spToken) throw new Error('empty accessToken returned')
    console.log(`✓ SP-audience token acquired (len=${spToken.length})`)
  } catch (err) {
    const msg = (err as Error).message
    console.log(`SP token acquisition failed: ${msg.split('\n')[0]}`)
    if (/consent|interaction_required|AADSTS65001/.test(msg)) {
      console.log('  → App reg has NO SharePoint delegated permission consented.')
      console.log('    Either: (1) IT adds `AllSites.Read` SP delegated perm + admin-consent (~1 minute),')
      console.log('    OR     (2) the user signs in interactively against the SP scope to grant consent.')
      console.log('    OR     (3) wait for Phase B app-only — `https://graph.microsoft.com/.default` with')
      console.log('               Application perms sidesteps the SP-token issue (Graph routes the call).')
    }
    await app.close(); return
  }

  // Follow DocIdRedir.aspx with redirect: manual so we can grab the Location header.
  let resolvedUrl: string | null = null
  try {
    const redirRes = await fetch(linkUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${spToken}`, Accept: 'application/json' },
      redirect: 'manual',
    })
    console.log(`DocIdRedir → status=${redirRes.status}  location=${redirRes.headers.get('location') ?? '∅'}`)
    if (redirRes.status >= 300 && redirRes.status < 400) {
      resolvedUrl = redirRes.headers.get('location')
    } else {
      const body = await redirRes.text()
      console.log(`unexpected body (first 300 chars): ${body.slice(0, 300)}`)
    }
  } catch (err) {
    console.log(`fetch DocIdRedir failed: ${(err as Error).message}`)
  }
  if (!resolvedUrl || resolvedUrl.startsWith('/_forms/')) {
    console.log('DocIdRedir rejects bearer tokens (it\'s a legacy _layouts page).')
    console.log('Falling through to Strategy G: SP REST /_api/search/query with DocId KQL.')

    // ── Strategy G — SharePoint REST search by DocId ──
    line('Strategy G — SP REST /_api/search/query  querytext=\'DocId:<id>\'')
    const spSearchUrl = `https://${TENANT_HOSTNAME}${SITE_PATH}/_api/search/query`
      + `?querytext='DocId:${encodeURIComponent(docId)}'`
      + `&selectproperties='Path,Title,UniqueId,SiteId,WebId,ListId,FileExtension'`
      + `&rowlimit=5`
    console.log(spSearchUrl)
    try {
      const r = await fetch(spSearchUrl, {
        headers: { Authorization: `Bearer ${spToken}`, Accept: 'application/json;odata=nometadata' },
      })
      console.log(`status = ${r.status}`)
      if (!r.ok) {
        console.log((await r.text()).slice(0, 400))
      } else {
        const json: any = await r.json()
        const rows = json?.PrimaryQueryResult?.RelevantResults?.Table?.Rows ?? []
        console.log(`row count = ${rows.length}`)
        for (const row of rows.slice(0, 3)) {
          const cells: Record<string, string> = {}
          for (const c of row.Cells ?? []) cells[c.Key] = c.Value
          console.log(`  Path     = ${cells.Path}`)
          console.log(`  Title    = ${cells.Title}`)
          console.log(`  UniqueId = ${cells.UniqueId}`)
          console.log(`  SiteId   = ${cells.SiteId}  WebId = ${cells.WebId}`)
        }
        if (rows.length) {
          const cells: Record<string, string> = {}
          for (const c of rows[0].Cells ?? []) cells[c.Key] = c.Value
          // We have UniqueId (driveItem id) but need driveId — re-resolve via Graph /shares/ with Path
          const filePath = cells.Path
          const b64Path = Buffer.from(filePath, 'utf-8').toString('base64')
            .replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')
          try {
            const driveItem = await graphGet(token, `/shares/u!${b64Path}/driveItem`)
            console.log(`\n✓ STRATEGY G WORKS — SP search → Path → Graph /shares/`)
            console.log(`  name        = ${driveItem.name}`)
            console.log(`  id          = ${driveItem.id}`)
            console.log(`  driveId     = ${driveItem.parentReference?.driveId}`)
            console.log(`  eTag        = ${driveItem.eTag}`)
            console.log(`  webUrl      = ${driveItem.webUrl}`)
            strategyEWin = true
          } catch (err) {
            console.log(`Graph /shares/ on resolved Path failed: ${(err as Error).message.split('\n')[0]}`)
          }
        }
      }
    } catch (err) {
      console.log(`SP search REST failed: ${(err as Error).message.split('\n')[0]}`)
    }

    console.log('\n────────────────────────────────────────────────────────────────────────')
    if (strategyEWin) {
      console.log(`✓ WINNER: Strategy G — SP REST search DocId → Path → Graph /shares/`)
      console.log('  Watcher pseudocode:')
      console.log('    1. acquire SP-audience token via MSAL silent for current session')
      console.log('    2. GET <site>/_api/search/query?querytext=\'DocId:<id>\'  → row.Cells.Path')
      console.log('    3. driveItem = GET /shares/u!{b64(Path)}/driveItem')
      console.log('    4. file     = GET /drives/{driveId}/items/{id}/content')
    } else {
      console.log('✗ All strategies failed. Stop here and escalate to admin.')
    }
    await app.close(); return
  }

  // (DocIdRedir followed; rare path, kept for completeness)
  console.log(`Resolved URL: ${resolvedUrl}`)

  // Try Graph /shares/ on the resolved URL (back in Graph land).
  const fb64 = Buffer.from(resolvedUrl, 'utf-8').toString('base64')
    .replace(/=+$/g, '').replace(/\//g, '_').replace(/\+/g, '-')
  try {
    const driveItem = await graphGet(token, `/shares/u!${fb64}/driveItem`)
    console.log(`\n✓ STRATEGY F WORKS — chain: SP-token → DocIdRedir 302 → Graph /shares/`)
    console.log(`  name        = ${driveItem.name}`)
    console.log(`  id          = ${driveItem.id}`)
    console.log(`  driveId     = ${driveItem.parentReference?.driveId}`)
    console.log(`  eTag        = ${driveItem.eTag}`)
    console.log(`  webUrl      = ${driveItem.webUrl}`)
    console.log(`  size        = ${driveItem.size}`)
    strategyEWin = true // reuse the win flag
  } catch (err) {
    console.log(`Graph /shares/ on resolved URL failed: ${(err as Error).message.split('\n')[0]}`)
  }

  console.log('\n────────────────────────────────────────────────────────────────────────')
  if (strategyEWin) {
    console.log(`✓ WINNER: Strategy E — /shares/u!<base64-url>/driveItem`)
    console.log('  Watcher pseudocode:')
    console.log('    1. read fields.Link.Url from the list row')
    console.log('    2. b64 = base64url(linkUrl)')
    console.log('    3. driveItem = GET /shares/u!{b64}/driveItem')
    console.log('    4. file     = GET /drives/{driveItem.parentReference.driveId}/items/{driveItem.id}/content')
  } else if (dWin) {
    console.log(`Partial: Strategy ${dWin.label.split(':')[0]} returns hits but no precise match for this row.`)
    console.log('Try Strategy B (SP REST DocIdRedir) — needs SP-audience token.')
  } else {
    console.log('✗ All Graph strategies failed. Fall back to Strategy B (SP REST DocIdRedir + SP-audience token).')
  }

  await app.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
