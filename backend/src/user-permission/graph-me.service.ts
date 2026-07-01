import type { Session } from '@prisma/client'
import { SessionService } from '../auth/session.service.js'

export interface GraphMe {
  id?: string
  displayName?: string
  mail?: string
  userPrincipalName?: string
  jobTitle?: string
  department?: string
}

/**
 * Fetches the caller's profile from Microsoft Graph `/me`. `department` is
 * NOT in Graph's default response — we always pass an explicit $select.
 */
export class GraphMeService {
  constructor(private readonly sessions: SessionService) {}

  /** Issue a fresh Graph token from the session and pull jobTitle + department. */
  async fetch(session: Session): Promise<GraphMe> {
    const token = await this.sessions.getGraphToken(session)
    return fetchGraphMe(token)
  }

  /** Same as fetch() but takes a pre-acquired token. Used by the login path. */
  async fetchWithToken(accessToken: string): Promise<GraphMe> {
    return fetchGraphMe(accessToken)
  }
}

async function fetchGraphMe(accessToken: string): Promise<GraphMe> {
  const url =
    'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department'
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /me → ${res.status}: ${body.slice(0, 300)}`)
  }
  return (await res.json()) as GraphMe
}
