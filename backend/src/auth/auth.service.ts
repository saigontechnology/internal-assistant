import type { Request, Response } from 'express'
import { AppConfig } from '../config/app-config.service.js'
import { GraphMeService } from '../user-permission/graph-me.service.js'
import { UserPermissionService } from '../user-permission/user-permission.service.js'
import { AdminRoleService } from './admin-role.service.js'
import { LoginEventBus } from './login-event-bus.js'
import { MsalService } from './msal.service.js'
import { SessionCookieService } from './session-cookie.service.js'
import { SessionService } from './session.service.js'

/**
 * Orchestrates the PKCE login dance. Stateless — pulls everything from
 * injected collaborators so it's testable without spinning up a real server.
 */
export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly msal: MsalService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookieService,
    private readonly graphMe: GraphMeService,
    private readonly perms: UserPermissionService,
    private readonly loginEvents: LoginEventBus,
    private readonly roles: AdminRoleService,
  ) {}

  /** Returns the Microsoft auth-code URL to redirect to. */
  async beginLogin(res: Response): Promise<string> {
    const { verifier, challenge } = await this.msal.cryptoProvider.generatePkceCodes()
    const state = this.msal.cryptoProvider.createNewGuid()
    this.cookies.setTx(res, { state, verifier })
    return this.msal.buildAuthCodeUrl({ state, codeChallenge: challenge })
  }

  /**
   * Complete the OAuth callback. Returns the URL to redirect the browser to
   * (success → frontendUrl, failure → frontendUrl/?auth=error).
   */
  async completeLogin(req: Request, res: Response, query: { code?: string; state?: string }): Promise<string> {
    const tx = this.cookies.readTx(req)
    this.cookies.clearTx(res)

    const failUrl = `${this.config.frontendUrl}/?auth=error`
    const deactivatedUrl = `${this.config.frontendUrl}/?auth=deactivated`

    if (!query.code || !tx) return failUrl
    if (!query.state || query.state !== tx.state) return failUrl

    try {
      const { result, tokenCache } = await this.msal.redeemCode({
        code: query.code,
        codeVerifier: tx.verifier,
      })
      const account = result.account!

      // Turn a deactivated user away before minting a session. SessionGuard
      // also enforces this on every request, for accounts deactivated
      // mid-session.
      const existing = await this.roles.getAccountState(account.username)
      if (existing && !existing.isActive) return deactivatedUrl

      const id = await this.sessions.create({
        homeAccountId: account.homeAccountId,
        tokenCache,
        username: account.username ?? null,
        name: account.name ?? null,
      })
      this.cookies.setSession(res, id)

      // Persist the user's job profile from Graph /me so the chat filter has
      // it ready on the next request. Best-effort — a /me failure shouldn't
      // block sign-in. The next authenticated request will read whatever's
      // in user_permissions; an empty row falls back to the default profile.
      const email = account.username
      if (email) {
        try {
          const me = await this.graphMe.fetchWithToken(result.accessToken)
          await this.perms.upsertProfile(email, me.jobTitle, me.department)
        } catch (err) {
          console.warn(
            `[auth] /me lookup failed for ${email}:`,
            (err as Error).message?.slice(0, 200),
          )
          // Make sure the row exists at least, so downstream code doesn't
          // need to handle a missing row.
          await this.perms.ensure(email).catch(() => {})
        }
        // Now that the row is guaranteed to exist, apply ADMIN_EMAILS. This is
        // what promotes a bootstrap admin who has never signed in before.
        await this.roles.promoteIfBootstrapAdmin(email).catch(() => {})
      }

      // Fire the post-login event so the per-profile sync starts NOW, not
      // when the user opens chat. Listener lives in UserPermissionModule.
      // Best-effort — listener errors are swallowed inside the bus.
      const fresh = await this.sessions.get(id).catch(() => null)
      if (fresh) this.loginEvents.emit(fresh)

      return this.config.frontendUrl
    } catch {
      return failUrl
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    const id = this.cookies.getSessionId(req)
    if (id) await this.sessions.delete(id)
    this.cookies.clearSession(res)
  }
}
