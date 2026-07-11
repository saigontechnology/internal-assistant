import { useState, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageList } from "./message-list";
import { ArrowUp, Pause } from "@phosphor-icons/react";
import { useConversations } from "@/lib/conversations";

function ActiveChat({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: UIMessage[];
}) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { saveMessages } = useConversations();

  // Transport sends ONLY the latest user message + chat id to the backend.
  // The server loads the prior turns from `chat_histories` by id and appends
  // before calling streamText. Memoized so it isn't reconstructed on every
  // render (which would otherwise tear down the open SSE connection).
  //
  // `prepareReconnectToStreamRequest` matches our backend route
  // (`GET /api/chat/:id/stream`) — used by `resume: true` on mount to
  // reconnect to an in-flight stream after a refresh / network drop.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest({ messages, id }) {
          return { body: { id, message: messages[messages.length - 1] } };
        },
        prepareReconnectToStreamRequest({ id }) {
          return { api: `/api/chat/${id}/stream` };
        },
      }),
    [],
  );

  const { messages, sendMessage, setMessages, status, error, stop } = useChat({
    id: conversationId,
    messages: initialMessages,
    transport,
    // On mount, ask the server whether there's an in-flight stream for this
    // chat. 204 → nothing to resume; otherwise the SSE picks up where it left
    // off. Backed by the resumable-stream + Redis wiring on the server.
    resume: true,
    onFinish: () => {
      saveRef.current?.();
    },
  });

  const saveRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    saveRef.current = () => {
      saveMessages(conversationId, messages);
    };
  });

  useEffect(() => {
    if (initialMessages.length > 0 && messages.length === 0) {
      setMessages(initialMessages);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [input]);

  const isActive = status === "submitted" || status === "streaming";

  const submit = () => {
    const text = input.trim();
    if (!text || isActive) return;
    setInput("");
    sendMessage({ text });
  };

  const sendSuggestion = (text: string) => {
    if (isActive) return;
    setInput("");
    sendMessage({ text });
  };

  // Explicit stop: with `resume: true`, `stop()` alone is treated as a
  // disconnect — the LLM keeps running server-side and a refresh would
  // reconnect. So we tell the server to cancel the underlying run and
  // hand it the partial assistant message we've rendered so far. Fired
  // as fire-and-forget; if the fetch fails the local `stop()` still runs.
  const requestStop = () => {
    const last = messages[messages.length - 1];
    const assistantMessage = last?.role === "assistant" ? last : undefined;
    void fetch(`/api/chat/${conversationId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(assistantMessage ? { assistantMessage } : {}),
    }).catch(() => {
      // Network drop or 4xx — the local disconnect below is still worth doing.
    });
    void stop();
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <MessageList
        messages={messages}
        status={status}
        onSuggestionClick={sendSuggestion}
      />

      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-6">
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
            {error.message || "Something went wrong. Please try again."}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="relative rounded-xl border border-input bg-card shadow-sm transition-all focus-within:border-ring focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/25"
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything of your documents…"
            disabled={isActive}
            rows={1}
            className="min-h-[3.25rem] max-h-48 resize-none rounded-xl border-0 bg-transparent px-4 pt-4.5 pr-12 pb-3.5 text-base leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent md:text-sm"
          />
          <Button
            // While streaming, the button stops the run instead of submitting.
            // `type="button"` (not "submit") to keep Enter / form-submit from
            // accidentally aborting the live stream.
            type={isActive ? "button" : "submit"}
            size="icon-sm"
            // Enabled while streaming (so the user can stop), and otherwise
            // only when they've typed something.
            disabled={!isActive && !input.trim()}
            onClick={isActive ? requestStop : undefined}
            aria-label={isActive ? "Stop generating" : "Send"}
            className="absolute inset-y-0 right-2 my-auto size-8 rounded-[0.4rem] active:translate-y-0"
          >
            {isActive ? <Pause /> : <ArrowUp />}
          </Button>
        </form>

        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Enter
          </kbd>{" "}
          to send
          <span className="mx-1.5 text-border">·</span>
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
            Shift+Enter
          </kbd>{" "}
          for newline
        </p>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { activeId, activeConversation, createConversation } =
    useConversations();

  useEffect(() => {
    if (!activeId) createConversation();
  }, [activeId, createConversation]);

  if (!activeId) return null;

  return (
    <ActiveChat
      key={activeId}
      conversationId={activeId}
      initialMessages={activeConversation?.messages ?? []}
    />
  );
}
