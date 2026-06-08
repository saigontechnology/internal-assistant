import { createMiddleware } from "hono/factory";
import { getSession, getGraphTokenForSession } from "../auth/session.js";

export type AuthVariables = {
  graphToken: string;
  user: { username: string | null; name: string | null };
};

/**
 * Gate a route behind a valid session cookie. Loads the session, silently
 * acquires a fresh Graph token, and exposes it via c.get("graphToken").
 */
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const session = await getSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    let token: string;
    try {
      token = await getGraphTokenForSession(session);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("graphToken", token);
    c.set("user", { username: session.username, name: session.name });
    await next();
  }
);
