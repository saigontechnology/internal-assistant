import { streamText, stepCountIs, type StreamTextResult } from 'ai'
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
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
- Every claim cites a filename inline, e.g. "(from report.pdf)".
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
    this.openai = createOpenAI({
      baseURL: this.config.openaiApiBase,
      apiKey: this.config.openaiApiKey,
    })
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
