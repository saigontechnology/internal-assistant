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
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { ResearchAgentService } from './research-agent.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Workflow — follow these steps in order:
1. Call listDocuments to see what files are available.
2. Call research(question) with a self-contained version of the user's question, mentioning relevant filenames if the user named any.
3. Read the research result and answer the user, citing filenames inline (e.g. "according to report.pdf"). Never use numeric indices like "Document 1".
4. If research returns no useful information, say so plainly.

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
    this.openai = createOpenAI({
      baseURL: this.config.openaiApiBase,
      apiKey: this.config.openaiApiKey,
    })
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

  async streamChat(messages: UIMessage[]): Promise<StreamTextResult<ReturnType<typeof this.buildTools>, never>> {
    const modelMessages = await convertToModelMessages(messages)
    return streamText({
      model: this.openai.chat(this.config.chatModel),
      system: SYSTEM_PROMPT,
      messages: modelMessages,
      tools: this.buildTools(),
      stopWhen: stepCountIs(4),
    })
  }
}
