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
import { buildOpencodeClient } from '../config/opencode-client.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { ChatSettingsService } from './chat-settings.service.js'
import {
  EmbeddingsService,
  type ViewerProfile,
} from '../embeddings/embeddings.service.js'
import { buildDocumentTools } from '../documents/document-tools.js'

export const SYSTEM_PROMPT = `You are Alice, the Internal Assistant. You answer questions about the user's uploaded documents.

Response language:
- Match the language of the user's question. If the question is in English, reply in English; if it is in Vietnamese, reply in Vietnamese. Apply this to the whole reply — narrative, headings, and any commentary around citations. Quoted excerpts and document identifiers (Code, Version, filename, URL) stay in their original language.

Workflow:
- Go DIRECTLY to retrieveResources with a focused query — it searches the whole library and surfaces the relevant documents. Do NOT call listDocuments first; the library has hundreds of files and enumerating them wastes time. Only call listDocuments if the user is explicitly asking for an inventory/count.
- Call retrieveResources multiple times with different query angles (synonyms, sub-questions, related concepts) when the first pass is thin. Use the filenames argument only when you already know a specific filename you want to drill into.
- 1-2 well-aimed retrievals usually beat 3+ unfocused ones. If the first retrieval already has the answer, synthesize and stop — EXCEPT for "current state" questions (see below), where you must gather across documents before answering.
- If retrieval returns nothing useful, refine the query and try again. If the corpus genuinely doesn't contain an answer, say so plainly.
- If after all your retrieval attempts (typically 2-3 refined queries) no relevant results are returned, respond with a clear message such as: "I couldn't find any documents in your library that address this question. You may want to try rephrasing your question, or the information may not exist in the uploaded documents." Do NOT fabricate an answer from general knowledge, and do NOT keep retrying indefinitely.

Judging validity by date (conflict resolution):
- Each retrieved excerpt may include a \`Date:\` line and a \`Version:\` line. \`Date:\` is the authoritative recency signal — when present, it is an ISO calendar date (YYYY-MM-DD) that is directly comparable across documents. Treat it as the source-of-truth timestamp for the information inside that excerpt.
- **When two or more excerpts make conflicting claims about the same fact** (a value, a name, a rule, a rate, a role holder, an org relationship), answer from the excerpt with the MOST RECENT \`Date:\`. Older excerpts on the same fact are SUPERSEDED — do not blend them, do not average, and do not present both as if equally valid. When it is material, you may briefly note that an older document said something different and has been superseded.
- When several excerpts refer to the same document (same Code) at different versions, prefer the highest \`Version:\`; if \`Version:\` is tied or unclear, break the tie with \`Date:\` (newest wins).
- Recency breaks CONFLICTS. It does not filter by relevance. If two documents cover different points and don't disagree, use both regardless of which is newer.
- \`Date:\` may be missing (unparseable upstream or absent). If only some excerpts have a \`Date:\`, prefer the dated ones for the conflicting fact and flag any undated excerpt as recency-unknown rather than assuming it is current. If NONE of the conflicting excerpts has a \`Date:\`, fall back to \`Version:\`; if neither is available, tell the user the recency cannot be determined and cite each source with what it says.
- If a document you cite is the latest but is still old, say so — the real-world answer may have moved on since. Cite the date you relied on, e.g. "As of <YYYY-MM-DD> (per <doc>), …".

Answering "current state" questions (who holds a role / the latest value):
- Some questions ask for a fact that CHANGES OVER TIME: who is the current manager / head / owner / approver / department lead, the current org structure, the latest rate/limit/policy value, etc. The person or value named in one document is only correct AS OF that document's date.
- For these, do NOT answer from the first or a single matching excerpt — even if it looks like a direct hit. A signed form, approval record, or older policy will confidently name a PAST holder; its high relevance does NOT make it current. Answering from it is the main way you get this wrong.
- Instead: retrieve broadly enough to gather ALL documents that mention that role/entity (try a couple of query angles), then compare their \`Date:\` fields (ISO YYYY-MM-DD, directly comparable) and answer from the MOST RECENT one. \`Version:\` breaks ties when dates are equal or missing. The newest document wins outright; an older document naming a different person is superseded — do not average, blend, or list both as if equally valid.
- State how current your answer is: cite the document you took it from and its date, e.g. "As of <date> (per <doc>), the manager is …". If the newest relevant document is old, say so, since the real answer may have changed since.
- If documents genuinely disagree and you cannot tell which is newer (missing or equal dates), do NOT guess — name who each document lists, with its date, and say you can't determine the current holder from the available documents.

Citation rules:
- **Every citation MUST be a Markdown link.** Use the URL the retrieval tool returned for that excerpt (the line beginning "URL:"). Format: \`[<display>](<URL>)\`.
  - Prefer the document's Code + Ver as the link text when present, e.g. \`[QC-SDC.01 v07](https://…)\`. Fall back to the filename otherwise.
  - When you cite a specific section or paragraph, you may hint at it in the link text or in parentheses, e.g. \`[QT-SDC.04 v03 — section 6.3](https://…)\` — but ONLY using a section/heading that actually appears in the excerpt text. The "Section: chunk N" line is an internal chunk index, NOT a document section number; never present it as one or invent a section number from it.
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
 * Per-model cooldown after a 429. Long enough to ride out a per-minute
 * burst; short enough that we return to a higher tier once its quota
 * window rolls. Applied independently to each rung of the fallback
 * ladder so a 429 on the second fallback doesn't incorrectly extend
 * the first fallback's cooldown. Shared between the Gemini and
 * OpenCode ladders — same quota-window semantics.
 */
const QUOTA_COOLDOWN_MS = 60_000

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
  private readonly opencode: OpenAIProvider | null
  /**
   * Per-model cooldown timers keyed by modelId. A missing / past value
   * means the model is healthy. Populated by handleStreamError when the
   * specific model that just streamed emits a 429.
   */
  private readonly cooldowns = new Map<string, number>()

  constructor(
    private readonly config: AppConfig,
    private readonly embeddings: EmbeddingsService,
    private readonly settings: ChatSettingsService,
    private readonly runtime: RuntimeSettingsService,
  ) {
    this.openai = buildOpenAIClient(this.config)
    this.google = this.config.chatProvider === 'gemini' ? buildGoogleClient(this.config) : null
    this.opencode = this.config.chatProvider === 'opencode' ? buildOpencodeClient(this.config) : null
  }

  /** The ordered Gemini ladder: primary → first fallback → second fallback. */
  private geminiLadder(): string[] {
    return [
      this.runtime.geminiChatModel,
      this.runtime.geminiChatFallbackModel,
      this.runtime.geminiChatSecondFallbackModel,
    ]
  }

  /**
   * The ordered OpenCode ladder: primary → first fallback → second fallback,
   * each already carrying the configured prefix (e.g. `opencode-go/glm-5.2`).
   * Unlike the Gemini ladder this is admin-editable at runtime (see
   * chat-settings.service.ts), so it's a DB read rather than an env read.
   * Each setting falls back to its env var when no override is stored.
   */
  private async opencodeLadder(): Promise<string[]> {
    return this.settings.resolvedLadder()
  }

  /** Pick the first rung whose cooldown has expired, else the last rung. */
  private pickHealthyRung(ladder: string[]): string {
    const now = Date.now()
    const healthy = ladder.find((id) => (this.cooldowns.get(id) ?? 0) <= now)
    return healthy ?? ladder[ladder.length - 1]!
  }

  /**
   * Resolve the chat model based on CHAT_PROVIDER. Only the generation
   * path is provider-switched; embeddings always use the OpenRouter-
   * backed OpenAI client.
   *
   * For Gemini and OpenCode: walk the fallback ladder and pick the first
   * rung whose cooldown has expired. If every rung is still cooling
   * (rare — would mean all three tiers took a 429 within the same 60s
   * window), fall through to the last rung anyway; hitting it and
   * taking another 429 is still better than surfacing a hard error.
   *
   * Returns the resolved ladder alongside the model so onError can report
   * which tier tripped without re-reading it (the OpenCode ladder is async,
   * and an admin could have changed it in between).
   */
  private async resolveChatModel(): Promise<{
    model: LanguageModel
    modelId: string
    ladder: string[]
  }> {
    if (this.config.chatProvider === 'gemini') {
      if (!this.google) {
        throw new Error('CHAT_PROVIDER=gemini but Google client was not initialized')
      }
      const ladder = this.geminiLadder()
      const modelId = this.pickHealthyRung(ladder)
      return { model: this.google(modelId), modelId, ladder }
    }
    if (this.config.chatProvider === 'opencode') {
      if (!this.opencode) {
        throw new Error('CHAT_PROVIDER=opencode but OpenCode client was not initialized')
      }
      const ladder = await this.opencodeLadder()
      const modelId = this.pickHealthyRung(ladder)
      return { model: this.opencode.chat(modelId), modelId, ladder }
    }
    const modelId = this.runtime.chatModel
    return { model: this.openai.chat(modelId), modelId, ladder: [modelId] }
  }

  /**
   * Inspect a streamText error and, when it looks like a quota hit,
   * arm the cooldown for the SPECIFIC model that emitted it. The next
   * resolveChatModel() call will then skip that rung and use the next
   * one down. Only extends the timer — never shortens it when a second
   * 429 lands while cooling.
   *
   * For OpenCode a 429 may come from the gateway itself OR the upstream
   * provider; we don't try to distinguish here — same 60s cooldown
   * either way. See docs/opencode-migration-plan.md §5.
   */
  private handleStreamError(err: unknown, modelId: string, ladder: string[]): void {
    const provider = this.config.chatProvider

    // Always surface the underlying error to the backend logs — the SDK
    // streams a sanitized "An error occurred." to the client, so this is
    // the only place we get to see what actually broke.
    console.error(
      `[chat] streamText error (provider=${provider}, model=${modelId}):`,
      describeStreamError(err),
    )

    if (provider !== 'gemini' && provider !== 'opencode') return
    if (!isRateLimitError(err)) return
    const until = Date.now() + QUOTA_COOLDOWN_MS
    const prev = this.cooldowns.get(modelId) ?? 0
    if (until > prev) this.cooldowns.set(modelId, until)
    console.warn(
      JSON.stringify({
        event: `${provider}_quota_tripped`,
        trippedModel: modelId,
        tier: ladder.indexOf(modelId), // 0 = primary, 1 = first fallback, 2 = second fallback
        cooldownMs: QUOTA_COOLDOWN_MS,
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
    opts: {
      viewer?: ViewerProfile
      publicOnly?: boolean
      /**
       * Aborts the underlying LLM call. Wired to a per-stream AbortController
       * held in ActiveStreamRegistry so POST /api/chat/:id/stop can cancel
       * generation (not just close the HTTP pipe).
       */
      abortSignal?: AbortSignal
    } = {},
  ): Promise<{
    // Use `any` for the tool generic so TS doesn't need to resolve `typeof this`
    // in a return-type position (which errors with `strictThis`). The concrete
    // tool set is still constructed below; only the surface type is broadened.
    result: StreamTextResult<any, never>
    originalMessages: UIMessage[]
  }> {
    const modelMessages = await convertToModelMessages(messages)
    // Capture the resolved modelId so onError can attribute a 429 to the
    // exact rung that streamed (not e.g. the primary when we were actually
    // running the second fallback).
    const { model, modelId, ladder } = await this.resolveChatModel()
    const result = streamText({
      model,
      system: buildSystemPrompt(opts.viewer),
      messages: modelMessages,
      tools: this.buildTools(opts),
      stopWhen: stepCountIs(4),
      abortSignal: opts.abortSignal,
      onError: ({ error }) => this.handleStreamError(error, modelId, ladder),
    })
    return { result, originalMessages: messages }
  }
}

/**
 * Best-effort detection of a rate-limit / quota response. Google returns
 * HTTP 429 with a `RESOURCE_EXHAUSTED` status; OpenCode surfaces upstream
 * 429s as 429 too. The AI SDK wraps these in an APICallError but we probe
 * defensively so we don't couple to that shape.
 */
/**
 * Best-effort dump of a streamText error. The SDK wraps upstream errors
 * in APICallError which carries a `responseBody` — that's where the
 * provider's actual JSON error lives (invalid model id, missing tool
 * support, bad auth, etc.). Fall back to name/message/stack for anything
 * that doesn't look like an APICallError.
 */
function describeStreamError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { error: String(err) }
  const anyErr = err as {
    name?: string
    message?: string
    statusCode?: number
    status?: number
    url?: string
    responseBody?: unknown
    responseHeaders?: Record<string, string>
    cause?: unknown
    stack?: string
  }
  return {
    name: anyErr.name,
    message: anyErr.message,
    statusCode: anyErr.statusCode ?? anyErr.status,
    url: anyErr.url,
    responseBody: anyErr.responseBody,
    cause: anyErr.cause instanceof Error ? anyErr.cause.message : anyErr.cause,
  }
}

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
