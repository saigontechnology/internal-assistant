import type { Session } from '@prisma/client'
import { SessionService } from '../auth/session.service.js'

/**
 * Returns a valid Microsoft Graph access token whenever called. Watcher code
 * depends on this abstraction so the Phase A → Phase B switch is just a
 * provider swap — see docs/sharepoint-list-watcher-plan.md §4.
 */
export interface GraphTokenProvider {
  getToken(): Promise<string>
}

/**
 * Phase A — issues the requesting user's delegated Graph token.
 * Constructed per-request from `req.session`. SessionService handles the
 * MSAL silent refresh under the hood.
 */
export class DelegatedGraphTokenProvider implements GraphTokenProvider {
  constructor(private readonly session: Session, private readonly sessions: SessionService) {}

  getToken(): Promise<string> {
    return this.sessions.getGraphToken(this.session)
  }
}
