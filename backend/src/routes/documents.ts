import { Hono } from "hono";
import {
  importFromSharePoint,
  uploadLocalFile,
  listDocuments,
  removeDocument,
} from "../services/document-service.js";
import type { ImportRequest } from "../types.js";
import { requireAuth, type AuthVariables } from "../middleware/require-auth.js";

export const documentsRoute = new Hono<{ Variables: AuthVariables }>();

documentsRoute.get("/", async (c) => {
  const documents = await listDocuments();
  return c.json({ documents });
});

documentsRoute.post("/upload", async (c) => {
  const body = await c.req.parseBody();
  const file = body["file"];

  if (!file || !(file instanceof File)) {
    return c.json({ error: "No file provided" }, 400);
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await uploadLocalFile(buffer, file.name);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return c.json({ error: message }, 400);
  }
});

documentsRoute.post("/import", requireAuth, async (c) => {
  const accessToken = c.get("graphToken");

  const body = await c.req.json<ImportRequest>();
  if (!body.files?.length) {
    return c.json({ error: "No files specified" }, 400);
  }

  const results = [];
  const errors = [];

  for (const fileRef of body.files) {
    try {
      const result = await importFromSharePoint(accessToken, fileRef);
      results.push(result);
    } catch (err) {
      errors.push({
        file: fileRef.name || fileRef.itemId,
        error: err instanceof Error ? err.message : "Import failed",
      });
    }
  }

  return c.json({ imported: results, errors }, errors.length > 0 ? 207 : 200);
});

documentsRoute.delete("/:docId", async (c) => {
  const docId = c.req.param("docId");

  try {
    await removeDocument(docId);
    return c.json({ message: "Document deleted successfully", id: docId });
  } catch {
    return c.json({ error: "Document not found" }, 404);
  }
});
