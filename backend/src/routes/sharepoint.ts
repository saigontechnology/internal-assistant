import { Hono } from "hono";
import {
  listSites,
  listDrives,
  listFiles,
  searchFiles,
} from "../services/sharepoint-service.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";

export const sharepointRoute = new Hono<{ Variables: AuthVariables }>();

sharepointRoute.use("*", requireAuth);

sharepointRoute.get("/sites", async (c) => {
  try {
    const sites = await listSites(c.get("graphToken"));
    return c.json({ sites });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to list sites" },
      500
    );
  }
});

sharepointRoute.get("/drives", async (c) => {
  const siteId = c.req.query("siteId");
  if (!siteId) {
    return c.json({ error: "siteId query parameter required" }, 400);
  }

  try {
    const drives = await listDrives(c.get("graphToken"), siteId);
    return c.json({ drives });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to list drives" },
      500
    );
  }
});

sharepointRoute.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const from = Number(c.req.query("from") ?? 0);

  try {
    const result = await searchFiles(c.get("graphToken"), q, Number.isFinite(from) ? from : 0);
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      500
    );
  }
});

sharepointRoute.get("/files", async (c) => {
  const siteId = c.req.query("siteId");
  const driveId = c.req.query("driveId");
  const folderId = c.req.query("folderId");

  if (!siteId || !driveId) {
    return c.json({ error: "siteId and driveId query parameters required" }, 400);
  }

  try {
    const files = await listFiles(c.get("graphToken"), siteId, driveId, folderId || undefined);
    return c.json({ files });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Failed to list files" },
      500
    );
  }
});
