import {
  ConfidentialClientApplication,
  CryptoProvider,
  type ICachePlugin,
  type TokenCacheContext,
  type AuthenticationResult,
} from "@azure/msal-node";
import { config, graphScopes } from "../config.js";

const authConfig = {
  clientId: config.azureClientId,
  authority: `https://login.microsoftonline.com/${config.azureTenantId}`,
  clientSecret: config.azureClientSecret,
};

export const cryptoProvider = new CryptoProvider();

// A confidential client with no cache persistence — used only to build the
// authorization-code URL (this step never touches the token cache).
const baseCca = new ConfidentialClientApplication({ auth: authConfig });

/**
 * Build a confidential client whose token cache is seeded from `initial` and
 * whose latest serialized state is written back into `sink.data` whenever it
 * changes. Each request gets its own client + cache so sessions never share
 * the in-memory MSAL cache.
 */
function makeCca(initial: string | null, sink: { data: string | null }) {
  const cachePlugin: ICachePlugin = {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
      if (initial) ctx.tokenCache.deserialize(initial);
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
      if (ctx.cacheHasChanged) sink.data = ctx.tokenCache.serialize();
    },
  };
  return new ConfidentialClientApplication({ auth: authConfig, cache: { cachePlugin } });
}

export async function buildAuthCodeUrl(params: {
  state: string;
  codeChallenge: string;
}): Promise<string> {
  return baseCca.getAuthCodeUrl({
    scopes: graphScopes,
    redirectUri: config.azureRedirectUri,
    state: params.state,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: "S256",
  });
}

/** Exchange an authorization code for tokens and return the serialized cache. */
export async function redeemCode(params: {
  code: string;
  codeVerifier: string;
}): Promise<{ result: AuthenticationResult; tokenCache: string }> {
  const sink = { data: null as string | null };
  const cca = makeCca(null, sink);
  const result = await cca.acquireTokenByCode({
    code: params.code,
    scopes: graphScopes,
    redirectUri: config.azureRedirectUri,
    codeVerifier: params.codeVerifier,
  });
  if (!result?.account) throw new Error("No account returned from token exchange");
  return { result, tokenCache: sink.data ?? "" };
}

/**
 * Acquire a fresh Graph access token for a session's serialized cache,
 * silently refreshing via the cached refresh token when needed. Returns the
 * token plus the (possibly updated) cache to persist back to the session.
 */
export async function acquireGraphToken(
  initialCache: string
): Promise<{ accessToken: string; tokenCache: string }> {
  const sink = { data: initialCache as string | null };
  const cca = makeCca(initialCache, sink);
  const account = (await cca.getTokenCache().getAllAccounts())[0];
  if (!account) throw new Error("No account in session cache");
  const result = await cca.acquireTokenSilent({ account, scopes: graphScopes });
  if (!result?.accessToken) throw new Error("Failed to acquire token silently");
  return { accessToken: result.accessToken, tokenCache: sink.data ?? initialCache };
}
