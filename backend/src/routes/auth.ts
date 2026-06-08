import { Hono } from "hono";
import { getSignedCookie, setSignedCookie, deleteCookie } from "hono/cookie";
import { config } from "../config.js";
import { buildAuthCodeUrl, redeemCode, cryptoProvider } from "../auth/msal.js";
import {
  createSession,
  getSession,
  deleteSession,
  setSessionCookie,
} from "../auth/session.js";

export const authRoute = new Hono();

// Short-lived cookie holding the PKCE verifier + CSRF state across the redirect.
const TX = "auth_tx";

const txCookieOpts = {
  httpOnly: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 600,
  secure: config.isProd,
};

authRoute.get("/login", async (c) => {
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const state = cryptoProvider.createNewGuid();

  await setSignedCookie(
    c,
    TX,
    JSON.stringify({ state, verifier }),
    config.sessionSecret,
    txCookieOpts
  );

  const url = await buildAuthCodeUrl({ state, codeChallenge: challenge });
  return c.redirect(url);
});

authRoute.get("/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const txRaw = await getSignedCookie(c, config.sessionSecret, TX);
  deleteCookie(c, TX, { path: "/" });

  const fail = () => c.redirect(`${config.frontendUrl}/?auth=error`);

  if (!code || !txRaw) return fail();

  let tx: { state: string; verifier: string };
  try {
    tx = JSON.parse(txRaw);
  } catch {
    return fail();
  }
  if (!state || state !== tx.state) return fail();

  try {
    const { result, tokenCache } = await redeemCode({
      code,
      codeVerifier: tx.verifier,
    });
    const account = result.account!;
    const id = await createSession({
      homeAccountId: account.homeAccountId,
      tokenCache,
      username: account.username ?? null,
      name: account.name ?? null,
    });
    setSessionCookie(c, id);
    return c.redirect(config.frontendUrl);
  } catch {
    return fail();
  }
});

authRoute.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ authenticated: false });
  return c.json({
    authenticated: true,
    user: { username: session.username, name: session.name },
  });
});

authRoute.post("/logout", async (c) => {
  await deleteSession(c);
  return c.json({ ok: true });
});
