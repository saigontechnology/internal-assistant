import {
  ConfidentialClientApplication,
  CryptoProvider,
  type AuthenticationResult,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node'
import { AppConfig, graphScopes } from '../config/app-config.service.js'

/**
 * MSAL helpers — ported from src/auth/msal.ts. Each request gets its own
 * confidential-client + cache so sessions never share MSAL's in-memory cache.
 */
export class MsalService {
  /** Stateless helper — safe to share across requests. */
  readonly cryptoProvider = new CryptoProvider()

  /** Confidential client with no cache — only used to build the auth-code URL. */
  private readonly baseCca: ConfidentialClientApplication

  constructor(private readonly config: AppConfig) {
    this.baseCca = new ConfidentialClientApplication({ auth: this.authConfig() })
  }

  private authConfig() {
    return {
      clientId: this.config.azureClientId,
      authority: `https://login.microsoftonline.com/${this.config.azureTenantId}`,
      clientSecret: this.config.azureClientSecret,
    }
  }

  private makeCca(initial: string | null, sink: { data: string | null }) {
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (ctx: TokenCacheContext) => {
        if (initial) ctx.tokenCache.deserialize(initial)
      },
      afterCacheAccess: async (ctx: TokenCacheContext) => {
        if (ctx.cacheHasChanged) sink.data = ctx.tokenCache.serialize()
      },
    }
    return new ConfidentialClientApplication({ auth: this.authConfig(), cache: { cachePlugin } })
  }

  buildAuthCodeUrl(params: { state: string; codeChallenge: string }): Promise<string> {
    return this.baseCca.getAuthCodeUrl({
      scopes: graphScopes,
      redirectUri: this.config.azureRedirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
    })
  }

  async redeemCode(params: { code: string; codeVerifier: string }): Promise<{
    result: AuthenticationResult
    tokenCache: string
  }> {
    const sink = { data: null as string | null }
    const cca = this.makeCca(null, sink)
    const result = await cca.acquireTokenByCode({
      code: params.code,
      scopes: graphScopes,
      redirectUri: this.config.azureRedirectUri,
      codeVerifier: params.codeVerifier,
    })
    if (!result?.account) throw new Error('No account returned from token exchange')
    return { result, tokenCache: sink.data ?? '' }
  }

  /** Acquire a fresh Graph access token, silently refreshing when possible. */
  async acquireGraphToken(initialCache: string): Promise<{ accessToken: string; tokenCache: string }> {
    const sink = { data: initialCache as string | null }
    const cca = this.makeCca(initialCache, sink)
    const account = (await cca.getTokenCache().getAllAccounts())[0]
    if (!account) throw new Error('No account in session cache')
    const result = await cca.acquireTokenSilent({ account, scopes: graphScopes })
    if (!result?.accessToken) throw new Error('Failed to acquire token silently')
    return { accessToken: result.accessToken, tokenCache: sink.data ?? initialCache }
  }
}
