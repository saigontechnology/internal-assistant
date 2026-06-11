import type { UIMessage } from "ai"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { User } from "lucide-react"
import { cn } from "@/lib/utils"
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

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === "user"
  const text = getMessageText(message)
  const toolParts = isUser ? [] : getToolParts(message)

  if (!text && toolParts.length === 0) return null

  return (
    <div
      className={cn(
        "flex gap-3.5 px-1 py-2.5 duration-300 animate-in fade-in slide-in-from-bottom-1",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-[0.4rem] border text-sm shadow-sm",
          isUser
            ? "border-transparent bg-foreground text-background"
            : "border-primary/30 bg-primary/10 font-semibold text-primary"
        )}
      >
        {isUser ? <User className="size-4" /> : "A"}
      </div>
      <div className={cn("flex max-w-[80%] flex-col gap-1.5", isUser && "items-end")}>
        <span className="label-eyebrow px-0.5 text-muted-foreground">
          {isUser ? "You" : "Alice"}
        </span>
        <div
          className={cn(
            "rounded-lg px-4 py-2.5 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-sm bg-primary text-primary-foreground shadow-sm whitespace-pre-wrap"
              : "rounded-tl-sm border border-border bg-card text-card-foreground shadow-sm"
          )}
        >
          {isUser ? (
            text
          ) : (
            <div className="prose-message">
              {toolParts.map((p) => (
                <ToolCall key={p.toolCallId} part={p as never} />
              ))}
              {text && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    // Citations link to SharePoint URLs on a different origin —
                    // open in a new tab + noopener so the chat session is
                    // never replaced and the destination can't reach window.opener.
                    a: ({ href, children, ...rest }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        {...rest}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {text}
                </ReactMarkdown>
              )}
              {isStreaming && <span className="streaming-caret" aria-hidden />}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
