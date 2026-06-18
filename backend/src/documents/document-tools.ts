import { tool } from 'ai'
import { z } from 'zod'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'

/**
 * Factory that produces the Vercel AI SDK tool definitions for the chat
 * agent. Takes the embeddings service as a closure so we don't reach into
 * a global — keeps DI honest.
 */
export function buildDocumentTools(embeddings: EmbeddingsService) {
  const listDocumentsTool = tool({
    description:
      "Return an aggregated summary of the user's document library (total count + per-department breakdown). Use this only when the user explicitly asks for an inventory or count. For finding specific documents to answer questions, call retrieveResources directly — it searches the full library.",
    inputSchema: z.object({}),
    execute: async () => {
      const docs = await embeddings.listResourcesWithCounts()
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
      const chunks = await embeddings.similaritySearch(query, { filenames })
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
