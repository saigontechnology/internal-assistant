import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type LanguageModel,
  type StreamTextResult,
  type UIMessage,
} from 'ai'
import { type OpenAIProvider } from '@ai-sdk/openai'
import { type GoogleGenerativeAIProvider } from '@ai-sdk/google'
import { AppConfig } from '../config/app-config.service.js'
import { buildOpenAIClient } from '../config/openai-client.js'
import { buildGoogleClient } from '../config/google-client.js'
import {
  EmbeddingsService,
  type ViewerProfile,
} from '../embeddings/embeddings.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Workflow:
- Go DIRECTLY to retrieveResources with a focused query — it searches the whole library and surfaces the relevant documents. Do NOT call listDocuments first; the library has hundreds of files and enumerating them wastes time. Only call listDocuments if the user is explicitly asking for an inventory/count.
- Call retrieveResources multiple times with different query angles (synonyms, sub-questions, related concepts) when the first pass is thin. Use the filenames argument only when you already know a specific filename you want to drill into.
- 1-2 well-aimed retrievals usually beat 3+ unfocused ones. If the first retrieval already has the answer, synthesize and stop.
- If retrieval returns nothing useful, refine the query and try again. If the corpus genuinely doesn't contain an answer, say so plainly.
- If after all your retrieval attempts (typically 2-3 refined queries) no relevant results are returned, respond with a clear message such as: "I couldn't find any documents in your library that address this question. You may want to try rephrasing your question, or the information may not exist in the uploaded documents." Do NOT fabricate an answer from general knowledge, and do NOT keep retrying indefinitely.

Use the latest version:
- Each retrieved excerpt may include a \`Version:\` line and a \`Date:\` line. Always answer from the MOST RECENT version of a document, since older versions may be superseded.
- When several excerpts refer to the same document (same Code) but different versions, treat the one with the highest \`Version:\` as authoritative. If the versions are ambiguous or equal, compare the \`Date:\` fields and prefer the most recent date.
- When multiple DIFFERENT documents are returned and they conflict or overlap, compare their \`Date:\` (and \`Version:\`) fields and base your answer on the newest, but note the discrepancy if an older document says something materially different.
- If you rely on the latest of several versions, you may briefly note that older versions exist and were superseded. Never blend content from an outdated version into the answer as if it were current.

Citation rules:
- **Every citation MUST be a Markdown link.** Use the URL the retrieval tool returned for that excerpt (the line beginning "URL:"). Format: \`[<display>](<URL>)\`.
  - Prefer the document's Code + Ver as the link text when present, e.g. \`[QC-SDC.01 v07](https://…)\`. Fall back to the filename otherwise.
  - When you cite a specific section or paragraph, hint at it in the link text or in parentheses afterwards, e.g. \`[QT-SDC.04 v03 — section 6.3](https://…)\`. Use the "Section:" field from the retrieval excerpt to ground the hint.
  - For PDFs, you MAY append \`#page=N\` to the URL only if the retrieval output explicitly says so. Do NOT invent page numbers.
- If a retrieved excerpt has no URL, fall back to citing it as plain text \`(from <filename>)\` — never invent a URL.
- Never use numeric indices like "Document 1" — always use the document's name/Code.

Tailor the answer to who is asking:
- A "Who you're talking to" section below (when present) tells you the current user's job title and department. Use it as context to make your answer relevant to THAT person.
- For role-specific processes (approvals, requests, onboarding, sign-offs, etc.), present the steps THIS user performs in their role. Do NOT walk them through steps that belong to a different role. For example, if an individual employee asks how to get something approved, describe what the employee submits and does — not the reviewer's/manager's/approver's internal steps.
- You MAY briefly mention who the next actor is ("your manager then reviews and approves") for context, but keep the actionable, step-by-step detail focused on the user's own responsibilities.
- If the user explicitly asks about another role's steps (e.g. a manager asking how to approve), answer for that role instead. When their role is unknown or the process isn't role-specific, give the general process.

Access control:
- If retrieveResources returns a result starting with \`ACCESS_DENIED:\`, the matching documents exist but the user is not permitted to read them. Respond clearly that they don't have permission to view the matching document(s) for this query, and suggest contacting an administrator if they need access. Do NOT speculate about the documents' contents, do NOT guess their names, do NOT call retrieveResources again with variations trying to bypass it, and do NOT mention any filename, code, title, or URL — none were returned to you.
- If retrieveResources returns excerpts followed by \`ACCESS_DENIED_PARTIAL:\`, answer normally from the excerpts you DID receive, and append one short line at the end of your reply telling the user that additional matching documents exist that they don't have permission to view. Do NOT name the restricted documents.`

/**
 * Top-level chat agent. Owns the LLM client and the document tools
 * (`listDocuments` for explicit inventory asks, `retrieveResources` for the
 * actual semantic search). A single LLM stream drives both retrieval and the
 * final answer so the user only waits for one generation pass.
 */
/**
 * How long we route Gemini traffic to the fallback model after a 429 on
 * the primary. Long enough to ride out a per-minute burst; short enough
 * that we return to the primary once its quota window rolls.
 */
const GEMINI_QUOTA_COOLDOWN_MS = 60_000

/**
 * Compose the system prompt for a single request, appending a "Who you're
 * talking to" section derived from the viewer's role so the model can tailor
 * role-specific answers (e.g. show an employee only their own approval steps).
 * Public / unauthenticated callers have no viewer, so the base prompt is used
 * unchanged and the model falls back to the general process.
 */
export function buildSystemPrompt(viewer?: ViewerProfile): string {
  if (!viewer) return SYSTEM_PROMPT
  return `${SYSTEM_PROMPT}

Who you're talking to:
- Job title: ${viewer.jobTitle}
- Department: ${viewer.department}`
}

export class ChatService {
  private readonly openai: OpenAIProvider
  private readonly google: GoogleGenerativeAIProvider | null
  /** Epoch ms until which we skip the Gemini primary and use the fallback. 0 = healthy. */
  private geminiQuotaTrippedUntil = 0

  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingsService,
  ) {
    this.openai = buildOpenAIClient(this.config)
    this.google = this.config.chatProvider === 'gemini' ? buildGoogleClient(this.config) : null
  }

  /**
   * Resolve the chat model based on CHAT_PROVIDER. Only the generation
   * path is provider-switched; embeddings always use OpenAI.
   *
   * When the Gemini primary has recently tripped a 429, route to the
   * configured fallback model until the cooldown expires.
   */
  private resolveChatModel(): LanguageModel {
    if (this.config.chatProvider === 'gemini') {
      if (!this.google) {
        throw new Error('CHAT_PROVIDER=gemini but Google client was not initialized')
      }
      const useFallback = Date.now() < this.geminiQuotaTrippedUntil
      const modelId = useFallback
        ? this.config.geminiChatFallbackModel
        : this.config.geminiChatModel
      return this.google(modelId)
    }
    return this.openai.chat(this.config.chatModel)
  }

  /**
   * Inspect a streamText error and, when it looks like a Gemini quota
   * hit, arm the cooldown so subsequent requests use the fallback model.
   */
  private handleStreamError(err: unknown): void {
    if (this.config.chatProvider !== 'gemini') return
    if (!isRateLimitError(err)) return
    const until = Date.now() + GEMINI_QUOTA_COOLDOWN_MS
    // Only extend the window; never shorten it if a second 429 lands while cooling.
    if (until > this.geminiQuotaTrippedUntil) this.geminiQuotaTrippedUntil = until
    console.warn(
      JSON.stringify({
        event: 'gemini_quota_tripped',
        primaryModel: this.config.geminiChatModel,
        fallbackModel: this.config.geminiChatFallbackModel,
        cooldownMs: GEMINI_QUOTA_COOLDOWN_MS,
      }),
    )
  }

  private buildTools(opts: { viewer?: ViewerProfile; publicOnly?: boolean }) {
    const { listDocumentsTool, retrieveResourcesTool } = buildDocumentTools(this.embeddings, opts)
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
    opts: { viewer?: ViewerProfile; publicOnly?: boolean } = {},
  ): Promise<{
    // Use `any` for the tool generic so TS doesn't need to resolve `typeof this`
    // in a return-type position (which errors with `strictThis`). The concrete
    // tool set is still constructed below; only the surface type is broadened.
    result: StreamTextResult<any, never>
    originalMessages: UIMessage[]
  }> {
    const modelMessages = await convertToModelMessages(messages)
    const result = streamText({
      model: this.resolveChatModel(),
      system: buildSystemPrompt(opts.viewer),
      messages: modelMessages,
      tools: this.buildTools(opts),
      stopWhen: stepCountIs(4),
      onError: ({ error }) => this.handleStreamError(error),
    })
    return { result, originalMessages: messages }
  }
}

/**
 * Best-effort detection of a rate-limit / quota response. Google returns
 * HTTP 429 with a `RESOURCE_EXHAUSTED` status; the AI SDK wraps this in
 * an APICallError but we probe defensively so we don't couple to that
 * shape.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const anyErr = err as { statusCode?: number; status?: number; message?: string; name?: string }
  if (anyErr.statusCode === 429 || anyErr.status === 429) return true
  const msg = (anyErr.message ?? '').toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota')
  )
}
