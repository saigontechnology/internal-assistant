import { tool } from 'ai'
import { z } from 'zod'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'

export interface DocumentToolsOptions {
  /**
   * Sharepoint codes the current user is NOT allowed to read. Applied as a
   * strict server-side post-filter inside both tools. Pass an empty set when
   * permissions are not in play (e.g., admin-mode calls). The forbidden codes
   * are NEVER returned to the LLM or echoed in tool output — a filtered chunk
   * simply does not appear.
   */
  unauthorizedCodes?: Set<string>
}

/**
 * Factory that produces the Vercel AI SDK tool definitions for the chat
 * agent. Takes the embeddings service as a closure so we don't reach into
 * a global — keeps DI honest.
 *
 * The optional `unauthorizedCodes` set filters retrieval and listing so a
 * user can never receive a citation from a document they cannot open in
 * SharePoint. See docs/per-user-sync-plan.md §6.
 */
export function buildDocumentTools(
  embeddings: EmbeddingsService,
  opts: DocumentToolsOptions = {},
) {
  const unauthorized = opts.unauthorizedCodes ?? new Set<string>()
  const listDocumentsTool = tool({
    description:
      "Return an aggregated summary of the user's document library (total count + per-department breakdown). Use this only when the user explicitly asks for an inventory or count. For finding specific documents to answer questions, call retrieveResources directly — it searches the full library.",
    inputSchema: z.object({}),
    execute: async () => {
      const all = await embeddings.listResourcesWithCounts()
      // Strip docs whose sharepointCode is in the user's unauthorized set
      // BEFORE aggregating so counts reflect what the caller can actually see.
      const docs = unauthorized.size === 0
        ? all
        : all.filter((d) => !d.sharepointCode || !unauthorized.has(d.sharepointCode))
      if (docs.length === 0) return 'The user has no documents uploaded.'
      // Aggregate by department code (e.g. "QT-HR.13" → "HR") instead of
      // dumping all N filenames into the prompt. A 375-row dump was costing
      // ~14k input tokens per agent step; this is ~50 tokens.
      const byDept = new Map<string, number>()
      for (const d of docs) {
        const code = d.sharepointCode ?? ''
        const m = code.match(/^[A-Z]+-([A-Z]+)/)
        const dept = m ? m[1] : code ? 'other' : 'uncategorized'
        byDept.set(dept, (byDept.get(dept) ?? 0) + 1)
      }
      const breakdown = [...byDept.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([dept, n]) => `- ${dept}: ${n}`)
        .join('\n')
      return `${docs.length} documents across ${byDept.size} departments:\n${breakdown}\n\nTo find specific documents, use retrieveResources with a focused query.`
    },
  })

  const retrieveResourcesTool = tool({
    description:
      "Search the user's uploaded document library and return the most relevant excerpts. Call this whenever the user asks anything that might be answered by their documents. Pass an optional filenames array to scope the search to specific files (use listDocuments first if you need to see what's available).",
    inputSchema: z.object({
      query: z.string().describe('A focused natural-language query describing what to find.'),
      filenames: z
        .array(z.string())
        .optional()
        .describe(
          'Optional list of document filenames (from listDocuments) to restrict the search to. Omit to search across the whole library.',
        ),
    }),
    execute: async ({ query, filenames }) => {
      // Server-side authorization filter. When the top-K is dominated by
      // unauthorized docs, re-issue the search with a wider K up to a small
      // bound so the agent still gets material to reason over. The forbidden
      // codes are never sent to the LLM — filtered chunks simply don't appear.
      let chunks = await embeddings.similaritySearch(query, { filenames })
      if (unauthorized.size > 0) {
        chunks = chunks.filter((c) => {
          const code = (c.metadata as Record<string, unknown>)?.code
          return typeof code !== 'string' || !unauthorized.has(code)
        })
        if (chunks.length === 0) {
          const widened = await embeddings.similaritySearch(query, { filenames, k: 24 })
          chunks = widened.filter((c) => {
            const code = (c.metadata as Record<string, unknown>)?.code
            return typeof code !== 'string' || !unauthorized.has(code)
          })
        }
      }
      if (chunks.length === 0) return 'No matching documents found.'
      // Surface link_url + chunk_index to the chat agent so it can render
      // proper markdown citations. The display name preference is
      // "<Code> v<Ver>" when present (sharepoint-list rows), else the
      // raw filename (legacy uploads / sharepoint imports).
      return chunks
        .map((c) => {
          const m = c.metadata as Record<string, unknown>
          const filename = m.filename as string | undefined
          const code = m.code as string | undefined
          const version = m.version as string | undefined
          const title = m.title as string | undefined
          const linkUrl = m.link_url as string | undefined
          const chunkIndex = m.chunk_index as string | undefined

          const display =
            code && version ? `${code} v${version}` :
            code ? code :
            filename ?? 'Unknown document'

          const lines: string[] = []
          lines.push(`--- From: ${display}`)
          if (title) lines.push(`Title: ${title}`)
          if (filename && code) lines.push(`Filename: ${filename}`)
          if (linkUrl) lines.push(`URL: ${linkUrl}`)
          if (chunkIndex !== undefined) lines.push(`Section: chunk ${chunkIndex}`)
          lines.push('---')
          lines.push(c.content as string)
          return lines.join('\n')
        })
        .join('\n\n---\n\n')
    },
  })

  return { listDocumentsTool, retrieveResourcesTool }
}
