import {
  convertToModelMessages,
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type StreamTextResult,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { ResearchAgentService } from './research-agent.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Workflow — follow these steps in order:
1. Call listDocuments to see what files are available, but DON'T SHOW the list in the response to the user.
2. Call research(question) with a self-contained version of the user's question, mentioning relevant filenames if the user named any.
3. Read the research result and answer the user.
4. If research returns no useful information, say so plainly.

Citation rules:
- The research subagent's output already contains Markdown links like \`[QC-SDC.01 v07](https://…)\`. **Preserve those links verbatim in your final answer** — keep both the link text and the URL. Never strip a link down to plain text.
- If the research output mentions a document without a link (e.g. \`(from report.pdf)\`), keep it as plain text — don't invent URLs.
- Never use numeric indices like "Document 1" — always use the document's name/Code.

Do not call any retrieval tool yourself — the research subagent handles that.`

/**
 * Top-level chat agent. Owns the LLM client and the two tools the orchestrator
 * sees: `listDocuments` (cheap inventory) and `research` (delegates to the
 * research subagent and streams its progress back).
 */
export class ChatService {
  private readonly openai: OpenAIProvider

  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingsService,
    private readonly research: ResearchAgentService,
  ) {
    this.openai = buildOpenAIClient(this.config)
  }

  private buildTools() {
    const { listDocumentsTool } = buildDocumentTools(this.embeddings)
    const research = this.research // closure capture so `this` doesn't leak into tool() generic inference
    const researchTool = tool({
      description:
        "Delegate the user's question to a research subagent. The subagent searches the document library and returns a citation-rich findings summary.",
      inputSchema: z.object({
        question: z
          .string()
          .describe('A self-contained question to research — the subagent will not see chat history.'),
      }),
      async *execute({ question }, { abortSignal }) {
        const result = research.streamResearch(question, abortSignal)
        for await (const message of readUIMessageStream({ stream: result.toUIMessageStream() })) {
          yield message
        }
      },
      toModelOutput: ({ output }) => {
        const message = output as UIMessage | undefined
        const finalText = message?.parts
          ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          ?.map((p) => p.text)
          ?.join('')
        return { type: 'text', value: finalText || 'Research completed.' }
      },
    })
    return { listDocuments: listDocumentsTool, research: researchTool }
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
  async streamReply(messages: UIMessage[]): Promise<{
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
      tools: this.buildTools(),
      stopWhen: stepCountIs(4),
    })
    return { result, originalMessages: messages }
  }
}
