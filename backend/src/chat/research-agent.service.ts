import { streamText, stepCountIs, type StreamTextResult } from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

const INSTRUCTIONS = `You are a research subagent for Alice, the Internal Assistant. Investigate the given question against the user's document library.

Approach:
- Start with listDocuments if you don't already know what files are available.
- Call retrieveResources multiple times with different query angles (synonyms, sub-questions, related concepts). Use the filenames argument to drill into specific files when relevant.
- Don't stop after a single search — aim for 2-3 retrievals covering different angles before synthesizing.
- If a retrieval returns nothing useful, refine the query and try again.

Output format:
- A concise findings summary (a few short paragraphs OR a bulleted list).
- **Every citation MUST be a Markdown link.** Use the URL the retrieval tool returned for that excerpt (the line beginning "URL:"). Format: \`[<display>](<URL>)\`.
  - Prefer the document's Code + Ver as the link text when present, e.g. \`[QC-SDC.01 v07](https://…)\`. Fall back to the filename otherwise.
  - When you cite a specific section or paragraph, hint at it in the link text or in parentheses afterwards, e.g. \`[QT-SDC.04 v03 — section 6.3](https://…)\`. Use the "Section:" field from the retrieval excerpt to ground the hint.
  - For PDFs, you MAY append \`#page=N\` to the URL if you genuinely know the page (the retrieval output will say so explicitly). Do NOT invent page numbers — most retrievals don't expose pages, in which case just link to the document.
- If a retrieved excerpt has no URL, fall back to citing it as plain text \`(from <filename>)\` — never invent a URL.
- If the corpus genuinely doesn't contain an answer, say so plainly.

Do not address the user directly — your output is consumed by another agent that will present the final answer.`

/**
 * Subagent that the chat agent delegates to. Owns its own LLM client + the
 * retrieval tools; takes no chat history so callers must inline any context
 * into the prompt.
 */
export class ResearchAgentService {
  private readonly openai: OpenAIProvider
  private readonly tools: ReturnType<typeof this.buildTools>

  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingsService,
  ) {
    this.openai = buildOpenAIClient(this.config)
    this.tools = this.buildTools()
  }

  private buildTools() {
    const { listDocumentsTool, retrieveResourcesTool } = buildDocumentTools(this.embeddings)
    return { listDocuments: listDocumentsTool, retrieveResources: retrieveResourcesTool }
  }

  streamResearch(
    question: string,
    abortSignal?: AbortSignal,
  ): StreamTextResult<typeof this.tools, never> {
    return streamText({
      model: this.openai.chat(this.config.chatModel),
      system: INSTRUCTIONS,
      prompt: question,
      tools: this.tools,
      stopWhen: stepCountIs(6),
      abortSignal,
    })
  }
}
