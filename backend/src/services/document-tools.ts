import { tool } from "ai";
import { z } from "zod";
import {
  similaritySearch,
  listResourcesWithCounts,
} from "./embedding-service.js";

export const listDocumentsTool = tool({
  description:
    "List every document the user has uploaded, with filename, file type, and chunk count. Call this before searching when you need to know what files exist or when the user asks about their library inventory.",
  inputSchema: z.object({}),
  execute: async () => {
    const docs = await listResourcesWithCounts();
    if (docs.length === 0) return "The user has no documents uploaded.";
    return docs
      .map(
        (d) =>
          `- ${d.filename} (${d.fileType.toUpperCase()}, ${d.chunkCount} chunks)`
      )
      .join("\n");
  },
});

export const retrieveResourcesTool = tool({
  description:
    "Search the user's uploaded document library and return the most relevant excerpts. Call this whenever the user asks anything that might be answered by their documents. Pass an optional filenames array to scope the search to specific files (use listDocuments first if you need to see what's available).",
  inputSchema: z.object({
    query: z
      .string()
      .describe("A focused natural-language query describing what to find."),
    filenames: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of document filenames (from listDocuments) to restrict the search to. Omit to search across the whole library."
      ),
  }),
  execute: async ({ query, filenames }) => {
    const chunks = await similaritySearch(query, { filenames });
    if (chunks.length === 0) return "No matching documents found.";
    return chunks
      .map((c) => `--- From: ${c.metadata.filename} ---\n${c.content}`)
      .join("\n\n---\n\n");
  },
});
