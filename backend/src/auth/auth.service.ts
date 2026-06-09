import type { Request, Response } from 'express'
import { AppConfig } from '../config/app-config.service.js'
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

    if (!query.code || !tx) return failUrl
    if (!query.state || query.state !== tx.state) return failUrl

    try {
      const { result, tokenCache } = await this.msal.redeemCode({
        code: query.code,
        codeVerifier: tx.verifier,
      })
      const account = result.account!
      const id = await this.sessions.create({
        homeAccountId: account.homeAccountId,
        tokenCache,
        username: account.username ?? null,
        name: account.name ?? null,
      })
      this.cookies.setSession(res, id)
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
