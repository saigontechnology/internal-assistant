import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, type Session } from "../db/schema.js";
import { config } from "../config.js";
import { acquireGraphToken } from "./msal.js";

const SID = "sid";
const MAX_AGE_S = 60 * 60 * 8; // 8 hours

export async function createSession(data: {
  homeAccountId: string;
  tokenCache: string;
  username: string | null;
  name: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db.insert(sessions).values({
    id,
    homeAccountId: data.homeAccountId,
    tokenCache: data.tokenCache,
    username: data.username,
    name: data.name,
    expiresAt: new Date(Date.now() + MAX_AGE_S * 1000),
  });
  return id;
}

export function setSessionCookie(c: Context, id: string): void {
  setCookie(c, SID, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: MAX_AGE_S,
    secure: config.isProd,
  });
}

export async function getSession(c: Context): Promise<Session | null> {
  const id = getCookie(c, SID);
  if (!id) return null;

  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) return null;

  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }
  return row;
}

export async function deleteSession(c: Context): Promise<void> {
  const id = getCookie(c, SID);
  if (id) await db.delete(sessions).where(eq(sessions.id, id));
  deleteCookie(c, SID, { path: "/" });
}

/** Resolve a Graph token for a session, persisting any refreshed cache. */
export async function getGraphTokenForSession(session: Session): Promise<string> {
  const { accessToken, tokenCache } = await acquireGraphToken(session.tokenCache);
  if (tokenCache && tokenCache !== session.tokenCache) {
    await db.update(sessions).set({ tokenCache }).where(eq(sessions.id, session.id));
  }
  return accessToken;
}
