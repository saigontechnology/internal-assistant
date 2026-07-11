import { useState } from "react"
import type { UIMessage } from "ai"
import { User, Copy, Check } from "@phosphor-icons/react"
import { Markdown } from "./markdown"
import { ToolCall } from "./tool-call"

interface MessageBubbleProps {
  message: UIMessage
  isStreaming?: boolean
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function getToolParts(message: UIMessage) {
  return message.parts.filter(
    (p): p is Extract<UIMessage["parts"][number], { type: `tool-${string}` }> =>
      typeof p.type === "string" && p.type.startsWith("tool-")
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      aria-label={copied ? "Copied" : "Copy message"}
      className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {copied ? (
        <Check className="size-3.5 text-primary" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}

/** Assistant reply — bubble-less prose against a document-margin rule, the way
    an annotation sits beside a page. Actions surface on hover. */
function AssistantMessage({
  message,
  text,
  isStreaming,
}: {
  message: UIMessage
  text: string
  isStreaming?: boolean
}) {
  const toolParts = getToolParts(message)
  return (
    <div className="group/msg flex gap-3.5 px-1 py-3 duration-300 animate-in fade-in slide-in-from-bottom-1">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 font-heading text-sm font-semibold text-primary shadow-xs">
        A
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="label-eyebrow px-0.5 text-muted-foreground">Alice</span>
        <div className="reply-margin prose-message min-w-0 [overflow-wrap:anywhere]">
          {toolParts.map((p) => (
            <ToolCall key={p.toolCallId} part={p as never} />
          ))}
          {text && <Markdown>{text}</Markdown>}
          {isStreaming && <span className="streaming-caret" aria-hidden />}
        </div>
        {!isStreaming && text && (
          <div className="pl-[1.125rem] opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
            <CopyButton text={text} />
          </div>
        )}
      </div>
    </div>
  )
}

/** User turn — a compact bubble in the primary colour, aligned to the right. */
function UserMessage({ text }: { text: string }) {
  return (
    <div className="group/msg flex flex-row-reverse gap-3.5 px-1 py-3 duration-300 animate-in fade-in slide-in-from-bottom-1">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-transparent bg-foreground text-sm text-background shadow-xs">
        <User className="size-4" />
      </div>
      <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1.5">
        <span className="label-eyebrow px-0.5 text-muted-foreground">You</span>
        <div className="min-w-0 rounded-lg rounded-tr-sm bg-primary px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground shadow-sm [overflow-wrap:anywhere]">
          {text}
        </div>
        <div className="opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={text} />
        </div>
      </div>
    </div>
  )
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === "user"
  const text = getMessageText(message)
  const toolParts = isUser ? [] : getToolParts(message)

  if (!text && toolParts.length === 0) return null

  return isUser ? (
    <UserMessage text={text} />
  ) : (
    <AssistantMessage message={message} text={text} isStreaming={isStreaming} />
  )
}
