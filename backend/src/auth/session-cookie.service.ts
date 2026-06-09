import type { Request, Response } from 'express'
import { AppConfig } from '../config/app-config.service.js'

/**
 * Centralizes cookie names + attributes so the rest of the auth code never
 * sets cookies directly. Two cookies are in play:
 *
 *   * `sid`      — plain DB-backed session id (matches the legacy Hono code).
 *   * `auth_tx`  — short-lived **signed** cookie holding the PKCE verifier
 *                  + state across the OAuth redirect.
 */
export const SESSION_COOKIE = 'sid'
export const TX_COOKIE = 'auth_tx'

const SESSION_MAX_AGE_S = 60 * 60 * 8        // 8 h, matches legacy
const TX_MAX_AGE_S = 60 * 10                  // 10 min, matches legacy

export class SessionCookieService {
  constructor(private readonly config: AppConfig) {}

  private base(maxAgeS: number) {
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: this.config.isProd,
      maxAge: maxAgeS * 1000, // express expects ms; hono used s — translated here
    }
  }

  setSession(res: Response, id: string) {
    res.cookie(SESSION_COOKIE, id, this.base(SESSION_MAX_AGE_S))
  }

  getSessionId(req: Request): string | null {
    return req.cookies?.[SESSION_COOKIE] ?? null
  }

  clearSession(res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' })
  }

  setTx(res: Response, payload: { state: string; verifier: string }) {
    res.cookie(TX_COOKIE, JSON.stringify(payload), {
      ...this.base(TX_MAX_AGE_S),
      signed: true,
    })
  }

  /**
   * Read the signed tx cookie. Returns `null` if absent OR tampered
   * (cookie-parser sets req.signedCookies[name] === false on signature
   * mismatch — we treat that the same as missing).
   */
  readTx(req: Request): { state: string; verifier: string } | null {
    const raw = req.signedCookies?.[TX_COOKIE]
    if (raw === undefined || raw === false) return null
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed?.state !== 'string' || typeof parsed?.verifier !== 'string') return null
      return parsed
    } catch {
      return null
    }
  }

  clearTx(res: Response) {
    res.clearCookie(TX_COOKIE, { path: '/' })
  }
}
