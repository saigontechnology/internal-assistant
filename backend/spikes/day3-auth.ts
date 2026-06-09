/**
 * Day-3 smoke: bootstrap AppConfig + Prisma + Auth on a real HTTP port,
 * exercise the four auth endpoints, and shut down.
 *
 *   GET  /api/auth/login    → 302 to login.microsoftonline.com
 *   GET  /api/auth/me       → {authenticated:false} with no cookie
 *   GET  /api/auth/me       → {authenticated:true,user:{...}} with valid sid
 *   POST /api/auth/logout   → {ok:true}
 *
 * We use the existing sessions row from the live DB (the one created when
 * you signed in earlier) to validate the read path without a full browser
 * OAuth round-trip.
 */
import 'reflect-metadata'
import 'dotenv/config'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import cookieParser from 'cookie-parser'
import { AppConfigModule } from '../src/config/config.module.js'
import { AppConfig } from '../src/config/app-config.service.js'
import { PrismaModule } from '../src/prisma/prisma.module.js'
import { PrismaService } from '../src/prisma/prisma.service.js'
import { AuthModule } from '../src/auth/auth.module.js'

@Module({
  imports: [AppConfigModule, PrismaModule, AuthModule],
})
class SmokeModule {}

const PORT = 7778

async function main() {
  const app = await NestFactory.create<NestExpressApplication>(SmokeModule, {
    logger: ['error', 'warn'],
  })
  const config = app.get(AppConfig)
  app.use(cookieParser(config.sessionSecret))
  app.setGlobalPrefix('api')
  await app.listen(PORT)

  const base = `http://localhost:${PORT}/api/auth`

  // 1) /me with no cookie
  const r1 = await fetch(`${base}/me`)
  console.log(`/me (no cookie)        → ${r1.status} ${await r1.text()}`)

  // 2) /login should 302 to microsoftonline.com and set the signed auth_tx cookie
  const r2 = await fetch(`${base}/login`, { redirect: 'manual' })
  const loginCookie = r2.headers.get('set-cookie') ?? ''
  console.log(`/login                 → ${r2.status} -> ${r2.headers.get('location')?.slice(0, 60)}…`)
  console.log(`                         set-cookie name: ${loginCookie.split('=')[0]}`)

  // 3) /me with the existing session id from the DB
  const prisma = app.get(PrismaService)
  const sample = await prisma.session.findFirst({ orderBy: { createdAt: 'desc' } })
  if (sample) {
    const r3 = await fetch(`${base}/me`, { headers: { cookie: `sid=${sample.id}` } })
    console.log(`/me (with sid=${sample.id.slice(0, 8)}…) → ${r3.status} ${await r3.text()}`)

    // 4) logout — deletes the row.
    const r4 = await fetch(`${base}/logout`, {
      method: 'POST',
      headers: { cookie: `sid=${sample.id}` },
    })
    console.log(`/logout                → ${r4.status} ${await r4.text()}`)

    // 5) verify the row is actually gone
    const after = await prisma.session.findUnique({ where: { id: sample.id } })
    console.log(`session row after logout: ${after ? 'STILL THERE ✗' : 'deleted ✓'}`)
  } else {
    console.log('(no sessions in DB — skipping authed /me + /logout)')
  }

  await app.close()
}
main().catch(e => { console.error(e); process.exit(1) })
