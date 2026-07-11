import { useEffect, useRef } from "react";
import type { UIMessage, ChatStatus } from "ai";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageBubble } from "./message-bubble";

interface MessageListProps {
  messages: UIMessage[];
  status: ChatStatus;
  onSuggestionClick?: (text: string) => void;
}

const SUGGESTIONS = [
  "Summarize the latest policy update",
  "Which documents mention onboarding?",
  "Compare the Q2 and Q3 reports",
];

function EmptyState({
  onSuggestionClick,
}: {
  onSuggestionClick?: (text: string) => void;
}) {
  return (
    <div className="flex flex-1 items-center px-6 sm:px-10">
      <div className="mx-auto -mt-8 w-full max-w-3xl duration-500 animate-in fade-in slide-in-from-bottom-2">
        <div className="label-eyebrow flex items-center gap-2.5 text-primary">
          <span className="inline-block h-px w-7 bg-primary/60" />
          Internal Assistant · Reading Room
        </div>

        <h2 className="mt-5 text-5xl leading-[0.95] font-light tracking-tight text-foreground text-balance sm:text-6xl md:text-7xl">
          Read between
          <br />
          <span className="font-normal text-primary">the lines.</span>
        </h2>
        <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground text-pretty">
          Ask anything of your documents — summaries, comparisons, the exact
          passage you half-remember. Start with a prompt below.
        </p>

        {onSuggestionClick && (
          <div className="mt-7 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggestionClick(s)}
                className="rounded-full border border-border bg-card px-3.5 py-1.5 text-sm text-muted-foreground shadow-xs transition-all hover:-translate-y-px hover:border-primary/40 hover:text-foreground hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  status,
  onSuggestionClick,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return <EmptyState onSuggestionClick={onSuggestionClick} />;
  }

  const isWaiting = status === "submitted";
  const isStreaming = status === "streaming";
  const lastAssistantIdx = (() => {
    if (!isStreaming) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  })();

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
          <div className="flex gap-3.5 px-1 py-3 duration-300 animate-in fade-in">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 font-heading text-sm font-semibold text-primary shadow-xs">
              A
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="label-eyebrow px-0.5 text-muted-foreground">
                Alice
              </span>
              <div className="reply-margin flex items-center gap-2.5">
                <span className="typing-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                <span className="thinking-text text-sm font-medium">
                  Consulting the archive…
                </span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
