/**
 * Strategy H — resolve list row → driveItem by predicting the filename from
 * `<Code> - <Title> - v<Ver>.<ext>` and Graph-searching for that phrase.
 *
 * Probes 25 rows; reports resolvable/dead/ambiguous.
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

const TENANT = 'saigontechnology0.sharepoint.com'
const SITE_PATH = '/SDC/ISOSDC'
const LIST = 'Danh mục total SDC'
const PROBE_N = 25

@Module({ imports: [AppConfigModule, PrismaModule, AuthModule] })
class M {}

const app = await NestFactory.createApplicationContext(M, { logger: ['error', 'warn'] })
const prisma = app.get(PrismaService)
const sessions = app.get(SessionService)

const session = await prisma.session.findFirst({ where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
if (!session) { console.error('no session'); await app.close(); process.exit(2) }
const token = await sessions.getGraphToken(session)

async function gget(p: string): Promise<any> {
  const r = await fetch(`https://graph.microsoft.com/v1.0${p}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}
async function gsearch(query: string): Promise<any[]> {
  const r = await fetch('https://graph.microsoft.com/v1.0/search/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{
      entityTypes: ['driveItem'],
      query: { queryString: query },
      fields: ['name', 'webUrl', 'parentReference', 'eTag', 'size'],
      from: 0, size: 5,
    }]}),
  })
  if (!r.ok) return []
  const j: any = await r.json()
  return j?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
}

const site = await gget(`/sites/${TENANT}:${SITE_PATH}`)
const lists = await gget(`/sites/${site.id}/lists?$filter=displayName eq '${encodeURIComponent(LIST)}'`)
const listId = lists.value[0].id

const items: any[] = []
let next: string | null = `/sites/${site.id}/lists/${listId}/items?$expand=fields&$top=200`
while (next) {
  const r = await gget(next)
  items.push(...(r.value ?? []))
  next = r['@odata.nextLink'] ? r['@odata.nextLink'].replace('https://graph.microsoft.com/v1.0', '') : null
}
console.log(`Total list rows: ${items.length}\n`)

function predictFilenameStem(code: string, title: string, ver: string): string {
  // observed convention: "<Code> - <Title> - v<Ver>"
  // Code can contain "/" (e.g. "PL01/QT-COM.03") — strip path-y chars for matching
  const cleanCode = code.replace(/[/\\]/g, ' ').trim()
  const v = ver.trim()
  return `${cleanCode} - ${title.trim()} - v${v}`
}

function fnMatchesPredicted(name: string, stem: string): boolean {
  // case-insensitive, allow any extension
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
  return norm(name).startsWith(norm(stem))
}

const sample = items.slice(0, PROBE_N)
const results: { id: string; code: string; ver: string; verdict: string; detail: string }[] = []
for (const it of sample) {
  const f = it.fields ?? {}
  const code = String(f.Code ?? '').trim()
  const title = String(f.Title ?? '').trim()
  const ver = String(f.Ver ?? '').trim()
  if (!code || !title) {
    results.push({ id: it.id, code, ver, verdict: 'malformed', detail: 'missing Code or Title' })
    continue
  }
  const stem = predictFilenameStem(code, title, ver)

  // Try Graph search with quoted phrase of the predicted stem
  let hits = await gsearch(`"${stem}"`)
  let matched = hits.find((h: any) => fnMatchesPredicted(h.resource?.name ?? '', stem))
  let usedFallback = false

  if (!matched) {
    // Fallback: search just by Code + Title — looser match
    hits = await gsearch(`"${code}" "${title}"`)
    matched = hits.find((h: any) => fnMatchesPredicted(h.resource?.name ?? '', stem))
    usedFallback = true
  }

  if (matched) {
    const r = matched.resource
    results.push({
      id: it.id, code, ver,
      verdict: usedFallback ? 'resolved (fallback)' : 'resolved',
      detail: r.name + '  driveId=' + (r.parentReference?.driveId?.slice(-10) ?? '?'),
    })
  } else {
    // Was anything returned that's close?
    const closest = hits[0]?.resource
    results.push({
      id: it.id, code, ver,
      verdict: 'dead',
      detail: closest ? `top hit didn't match: ${closest.name}` : 'no hits at all',
    })
  }
}

console.log(`Sampled ${sample.length} rows. Predicted filename stem = "<Code> - <Title> - v<Ver>".\n`)
for (const r of results) {
  const ok = r.verdict.startsWith('resolved') ? '✓' : (r.verdict === 'malformed' ? '⚠' : '✗')
  console.log(`${ok} #${r.id.padEnd(3)} ${r.code.padEnd(22)} v${r.ver.padEnd(3)}  ${r.verdict.padEnd(20)} ${r.detail}`)
}
const ok = results.filter(r => r.verdict.startsWith('resolved')).length
const dead = results.filter(r => r.verdict === 'dead').length
const mal = results.filter(r => r.verdict === 'malformed').length
console.log(`\nResolved: ${ok}/${sample.length}    Dead: ${dead}    Malformed: ${mal}`)

await app.close()
