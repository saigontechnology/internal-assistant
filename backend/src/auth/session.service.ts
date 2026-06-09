import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { MsalService } from './msal.service.js'
import type { Session } from '@prisma/client'

const MAX_AGE_S = 60 * 60 * 8 // 8 h

export interface AuthedUser {
  id: string
  username: string | null
  name: string | null
}

export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly msal: MsalService,
  ) {}

  async create(data: {
    homeAccountId: string
    tokenCache: string
    username: string | null
    name: string | null
  }): Promise<string> {
    const id = randomUUID()
    await this.prisma.session.create({
      data: {
        id,
        homeAccountId: data.homeAccountId,
        tokenCache: data.tokenCache,
        username: data.username,
        name: data.name,
        expiresAt: new Date(Date.now() + MAX_AGE_S * 1000),
      },
    })
    return id
  }

  /** Load a session by id, evicting expired rows. */
  async get(id: string): Promise<Session | null> {
    const row = await this.prisma.session.findUnique({ where: { id } })
    if (!row) return null
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.session.delete({ where: { id } }).catch(() => {})
      return null
    }
    return row
  }

  async delete(id: string): Promise<void> {
    await this.prisma.session.delete({ where: { id } }).catch(() => {})
  }

  /** Resolve a fresh Graph token for a session, persisting any refreshed cache. */
  async getGraphToken(session: Session): Promise<string> {
    const { accessToken, tokenCache } = await this.msal.acquireGraphToken(session.tokenCache)
    if (tokenCache && tokenCache !== session.tokenCache) {
      await this.prisma.session.update({ where: { id: session.id }, data: { tokenCache } })
    }
    return accessToken
  }
}
