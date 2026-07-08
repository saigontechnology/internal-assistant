import { randomUUID } from 'node:crypto'
import { PrismaService } from '../prisma/prisma.service.js'
import { MsalService } from './msal.service.js'
import type { Session } from '@prisma/client'

const MAX_AGE_S = 60 * 60 * 8 // 8 h

/**
 * Sliding-window threshold. When a request lands with less than this much
 * time left on the session, `get()` rolls `expiresAt` forward by another
 * `MAX_AGE_S`. Half the max age means an active user pays at most one
 * write per ~4 h, and an idle user still ages out cleanly at the 8 h mark.
 */
const RENEW_THRESHOLD_MS = (MAX_AGE_S / 2) * 1000

/**
 * How often we re-validate the session against Azure AD via MSAL, on top
 * of the local sliding window. The sliding cookie is the fast path — a
 * cheap DB read on every request. This check runs *at most* once per
 * session per interval and asks MSAL to acquire a Graph token; if that
 * fails with a credential error (RT revoked, account disabled, MFA
 * re-prompt required, admin-flipped conditional-access policy) the
 * session is deleted and the user is bounced to /login.
 *
 * 4 h is the compromise: revocations propagate within one window, but a
 * healthy active user hits Azure at most once per 4 h — usually zero
 * network calls because MSAL will just cache-hit the access token.
 */
const AZURE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * MSAL error codes / substrings that indicate the user's credentials are
 * no longer valid at Azure — the correct response is to delete the
 * session and force re-login. Anything else (network blips, AAD 5xx,
 * unclassified errors) is treated as transient: log and let the existing
 * session through so a brief Azure outage doesn't log everyone out.
 */
const AZURE_CREDENTIAL_ERROR_CODES = new Set([
  'invalid_grant',
  'interaction_required',
  'login_required',
  'consent_required',
  'user_cancelled',
  'no_account_error',
  'no_account_in_silent_request',
])

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
    const now = new Date()
    await this.prisma.session.create({
      data: {
        id,
        homeAccountId: data.homeAccountId,
        tokenCache: data.tokenCache,
        username: data.username,
        name: data.name,
        expiresAt: new Date(now.getTime() + MAX_AGE_S * 1000),
        // Fresh login IS an Azure validation — stamp it so the guard
        // doesn't immediately re-check on the next request.
        lastAzureCheckAt: now,
      },
    })
    return id
  }

  /**
   * Load a session by id and apply the hybrid liveness policy:
   *
   * 1. Reject expired rows outright.
   * 2. Slide `expiresAt` forward when the row is within RENEW_THRESHOLD_MS
   *    of expiry — the cheap local-only path an active user hits 99% of
   *    the time.
   * 3. Once per AZURE_CHECK_INTERVAL_MS, additionally run
   *    `acquireTokenSilent` against MSAL. Success → refresh
   *    `lastAzureCheckAt` (and any rotated `tokenCache`). A credential
   *    error → delete the session and return null so the guard replies 401.
   *    Network / transient errors → log and let the session through; the
   *    next request will try the check again.
   */
  async get(id: string): Promise<Session | null> {
    let row = await this.prisma.session.findUnique({ where: { id } })
    if (!row) return null

    const now = Date.now()
    if (row.expiresAt.getTime() < now) {
      await this.prisma.session.delete({ where: { id } }).catch(() => {})
      return null
    }

    // ── Sliding TTL ──
    if (row.expiresAt.getTime() - now < RENEW_THRESHOLD_MS) {
      try {
        row = await this.prisma.session.update({
          where: { id },
          data: { expiresAt: new Date(now + MAX_AGE_S * 1000) },
        })
      } catch {
        // Best-effort — fall through with the row we already have.
      }
    }

    // ── Periodic Azure check ──
    const lastCheck = row.lastAzureCheckAt?.getTime() ?? 0
    if (now - lastCheck > AZURE_CHECK_INTERVAL_MS) {
      const outcome = await this.validateAgainstAzure(row)
      if (outcome === 'revoked') return null
      if (typeof outcome === 'object') row = outcome.row
      // 'transient' → keep using `row` as-is; don't stamp lastAzureCheckAt
      // so we try again on the next request instead of waiting another
      // full interval.
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

  /**
   * Ask MSAL for a Graph token. Success stamps `lastAzureCheckAt` and
   * persists any rotated tokenCache. Credential errors delete the
   * session. Transient errors return 'transient' so the caller keeps
   * the session but doesn't advance the check timestamp.
   */
  private async validateAgainstAzure(
    session: Session,
  ): Promise<'revoked' | 'transient' | { kind: 'ok'; row: Session }> {
    try {
      const { tokenCache } = await this.msal.acquireGraphToken(session.tokenCache)
      const now = new Date()
      const data: { lastAzureCheckAt: Date; tokenCache?: string } = { lastAzureCheckAt: now }
      if (tokenCache && tokenCache !== session.tokenCache) data.tokenCache = tokenCache
      const row = await this.prisma.session.update({ where: { id: session.id }, data })
      return { kind: 'ok', row }
    } catch (err) {
      if (isAzureCredentialError(err)) {
        console.warn(
          JSON.stringify({
            event: 'session_revoked_by_azure',
            sessionId: session.id,
            reason: describeError(err),
          }),
        )
        await this.prisma.session.delete({ where: { id: session.id } }).catch(() => {})
        return 'revoked'
      }
      console.warn(
        JSON.stringify({
          event: 'session_azure_check_transient',
          sessionId: session.id,
          reason: describeError(err),
        }),
      )
      return 'transient'
    }
  }
}

/**
 * Classify an MSAL error as "credentials no longer valid at Azure" vs.
 * "transient network/server issue". Errs on the side of transient: we
 * only kick the user when we're confident Azure said no, so a brief AAD
 * outage doesn't log everyone out.
 */
function isAzureCredentialError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const anyErr = err as { errorCode?: string; name?: string; message?: string }
  const code = anyErr.errorCode?.toLowerCase() ?? ''
  if (AZURE_CREDENTIAL_ERROR_CODES.has(code)) return true
  const name = anyErr.name ?? ''
  if (name === 'InteractionRequiredAuthError') return true
  const msg = (anyErr.message ?? '').toLowerCase()
  // AADSTS50173 / AADSTS700082 / AADSTS50076 etc. — grant / MFA / account state.
  // Match any AADSTS* prefix but require an explicit "invalid" / "expired" /
  // "revoked" keyword nearby so generic AAD info messages don't kick users.
  if (
    msg.includes('aadsts') &&
    /(invalid|expired|revoked|disabled|not\s+found|password)/.test(msg)
  ) {
    return true
  }
  return false
}

function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const anyErr = err as { errorCode?: string; name?: string; message?: string }
  return anyErr.errorCode ?? anyErr.name ?? anyErr.message ?? 'unknown'
}
