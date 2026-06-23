import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type StreamTextResult,
  type UIMessage,
} from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Workflow:
- Go DIRECTLY to retrieveResources with a focused query — it searches the whole library and surfaces the relevant documents. Do NOT call listDocuments first; the library has hundreds of files and enumerating them wastes time. Only call listDocuments if the user is explicitly asking for an inventory/count.
- Call retrieveResources multiple times with different query angles (synonyms, sub-questions, related concepts) when the first pass is thin. Use the filenames argument only when you already know a specific filename you want to drill into.
- 1-2 well-aimed retrievals usually beat 3+ unfocused ones. If the first retrieval already has the answer, synthesize and stop.
- If retrieval returns nothing useful, refine the query and try again. If the corpus genuinely doesn't contain an answer, say so plainly.

Citation rules:
- **Every citation MUST be a Markdown link.** Use the URL the retrieval tool returned for that excerpt (the line beginning "URL:"). Format: \`[<display>](<URL>)\`.
  - Prefer the document's Code + Ver as the link text when present, e.g. \`[QC-SDC.01 v07](https://…)\`. Fall back to the filename otherwise.
  - When you cite a specific section or paragraph, hint at it in the link text or in parentheses afterwards, e.g. \`[QT-SDC.04 v03 — section 6.3](https://…)\`. Use the "Section:" field from the retrieval excerpt to ground the hint.
  - For PDFs, you MAY append \`#page=N\` to the URL only if the retrieval output explicitly says so. Do NOT invent page numbers.
- If a retrieved excerpt has no URL, fall back to citing it as plain text \`(from <filename>)\` — never invent a URL.
- Never use numeric indices like "Document 1" — always use the document's name/Code.`

/**
 * Top-level chat agent. Owns the LLM client and the document tools
 * (`listDocuments` for explicit inventory asks, `retrieveResources` for the
 * actual semantic search). A single LLM stream drives both retrieval and the
 * final answer so the user only waits for one generation pass.
 */
export class ChatService {
  private readonly openai: OpenAIProvider

  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingsService,
  ) {
    this.openai = buildOpenAIClient(this.config)
  }

  private buildTools(unauthorizedCodes: Set<string>) {
    const { listDocumentsTool, retrieveResourcesTool } = buildDocumentTools(this.embeddings, {
      unauthorizedCodes,
    })
    return { listDocuments: listDocumentsTool, retrieveResources: retrieveResourcesTool }
  }

  /**
   * Stream a reply against the full message history. Returns both the
   * streamText result AND the (unchanged) message array so the caller can
   * pass it as `originalMessages` to the response pipe — that's what tells
   * the SDK which messages already exist on the client and which to
   * generate IDs for in the assistant turn.
   *
   * No `validateUIMessages` call here: the previous messages come from our
   * own DB (trusted by construction) and the single new message is a plain
   * user text part with no tool data to validate.
   */
  async streamReply(
    messages: UIMessage[],
    opts: { unauthorizedCodes?: Set<string> } = {},
  ): Promise<{
    // Use `any` for the tool generic so TS doesn't need to resolve `typeof this`
    // in a return-type position (which errors with `strictThis`). The concrete
    // tool set is still constructed below; only the surface type is broadened.
    result: StreamTextResult<any, never>
    originalMessages: UIMessage[]
  }> {
    const modelMessages = await convertToModelMessages(messages)
    const result = streamText({
      model: this.openai.chat(this.config.chatModel),
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools: this.buildTools(opts.unauthorizedCodes ?? new Set()),
      stopWhen: stepCountIs(4),
    })
    return { result, originalMessages: messages }
  }
}
