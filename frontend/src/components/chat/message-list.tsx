import { useEffect, useRef } from "react"
import type { UIMessage, ChatStatus } from "ai"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MessageBubble } from "./message-bubble"

interface MessageListProps {
  messages: UIMessage[]
  status: ChatStatus
  onSuggestionClick?: (text: string) => void
}

const SUGGESTIONS = [
  "Summarize my most recent upload",
  "Surface the key themes across my library",
  "Compare what my documents say on a topic",
  "Find the passage I half-remember",
]

export function MessageList({ messages, status, onSuggestionClick }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center px-6 sm:px-10">
        <div className="mx-auto w-full max-w-3xl -mt-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
          <div className="label-eyebrow flex items-center gap-2.5 text-primary">
            <span className="inline-block h-px w-7 bg-primary/60" />
            Internal Assistant · Reading Room
          </div>

          <h2 className="mt-5 font-display text-6xl leading-[0.95] font-light tracking-tight text-foreground sm:text-7xl">
            Read between
            <br />
            <em className="font-normal text-primary italic">the lines.</em>
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Ask anything of your documents — summaries, comparisons, the exact
            passage you half-remember. Start with a prompt below.
          </p>

          <ul className="mt-10 border-t border-border">
            {SUGGESTIONS.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  onClick={() => onSuggestionClick?.(s)}
                  className="group flex w-full items-baseline gap-4 border-b border-border py-3.5 text-left transition-colors hover:bg-accent/40"
                >
                  <span className="font-mono text-xs tabular-nums text-muted-foreground/70 transition-colors group-hover:text-primary">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex-1 text-[0.95rem] text-muted-foreground transition-colors group-hover:text-foreground">
                    {s}
                  </span>
                  <span
                    aria-hidden
                    className="translate-x-0 text-muted-foreground/50 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:text-primary group-hover:opacity-100"
                  >
                    →
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  const isWaiting = status === "submitted"
  const isStreaming = status === "streaming"
  const lastAssistantIdx = (() => {
    if (!isStreaming) return -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i
    }
    return -1
  })()

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-6">
        {messages.map((message, i) => (
          <MessageBubble
            key={message.id}
            message={message}
            isStreaming={i === lastAssistantIdx}
          />
        ))}
        {isWaiting && (
          <div className="flex gap-3.5 px-1 py-2.5 duration-300 animate-in fade-in">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-[0.4rem] border border-primary/30 bg-primary/10 font-display text-sm font-semibold text-primary shadow-sm">
              A
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="label-eyebrow px-0.5 text-muted-foreground">
                Alice
              </span>
              <div className="rounded-lg rounded-tl-sm border border-border bg-card px-4 py-2.5 shadow-sm">
                <span className="shimmer-text text-sm font-medium">
                  Consulting the archive…
                </span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  )
}
