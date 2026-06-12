/**
 * Probe: call the EXACT watcher resolveByCode() path for row 19 (QC-SDC.01).
 * Spike returns hits. Watcher run returned 0. Find the divergence.
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
import { SharepointListService, buildPredictedStem } from '../src/sharepoint-list/sharepoint-list.service.js'
import { DelegatedGraphTokenProvider } from '../src/sharepoint-list/graph-token-provider.js'
import { AppConfig } from '../src/config/app-config.service.js'

@Module({ imports: [AppConfigModule, PrismaModule, AuthModule] })
class M {}

const app = await NestFactory.createApplicationContext(M, { logger: ['error', 'warn'] })
const prisma = app.get(PrismaService)
const sessions = app.get(SessionService)
const config = app.get(AppConfig)

const session = await prisma.session.findFirst({ where: { expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } })
if (!session) { console.error('no session'); await app.close(); process.exit(2) }

const listSvc = new SharepointListService(config)
const tokens = new DelegatedGraphTokenProvider(session, sessions)

const args = {
  code: 'QC-SDC.01',
  title: 'Quy chế tổ chức khối Phát triển phần mềm',
  version: '07',
}
console.log('stem =', JSON.stringify(buildPredictedStem(args)))

const result = await listSvc.resolveByCode(tokens, args)
console.log('result =', JSON.stringify(result, null, 2))

// Also call the raw Graph endpoint to compare.
const token = await tokens.getToken()
const stem = buildPredictedStem(args)
const res = await fetch('https://graph.microsoft.com/v1.0/search/query', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    requests: [{
      entityTypes: ['driveItem'],
      query: { queryString: `"${stem}"` },
      fields: ['name', 'parentReference', 'eTag', 'size', 'webUrl'],
      from: 0,
      size: 5,
    }],
  }),
})
const j: any = await res.json()
const hits = j?.value?.[0]?.hitsContainers?.[0]?.hits ?? []
console.log('\nraw Graph hit count =', hits.length)
hits.slice(0, 3).forEach((h: any, i: number) => console.log(`  [${i}] ${h.resource?.name}`))

await app.close()
