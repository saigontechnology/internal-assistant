import { useState, useEffect, useRef, type KeyboardEvent } from "react"
import { useChat } from "@ai-sdk/react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MessageList } from "./message-list"
import { ArrowUp } from "lucide-react"
import { useConversations } from "@/lib/conversations"
import type { UIMessage } from "ai"

function ActiveChat({
  conversationId,
  initialMessages,
}: {
  conversationId: string
  initialMessages: UIMessage[]
}) {
  const [input, setInput] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { saveMessages } = useConversations()

  const { messages, sendMessage, setMessages, status, error } = useChat({
    id: conversationId,
    messages: initialMessages,
    onFinish: () => {
      saveRef.current?.()
    },
  })

  const saveRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => {
    saveRef.current = () => {
      saveMessages(conversationId, messages)
    }
  })

  useEffect(() => {
    if (initialMessages.length > 0 && messages.length === 0) {
      setMessages(initialMessages)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`
  }, [input])

  const isActive = status === "submitted" || status === "streaming"

  const submit = () => {
    const text = input.trim()
    if (!text || isActive) return
    setInput("")
    sendMessage({ text })
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    submit()
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const fillAndFocus = (text: string) => {
    setInput(text)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  return (
    <div className="flex h-full flex-col">
      <MessageList
        messages={messages}
        status={status}
        onSuggestionClick={fillAndFocus}
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
            className="min-h-[3.25rem] max-h-48 resize-none rounded-xl border-0 bg-transparent px-4 pt-3.5 pr-12 pb-3.5 text-base leading-relaxed shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent md:text-sm"
          />
          <Button
            type="submit"
            size="icon-sm"
            disabled={isActive || !input.trim()}
            className="absolute right-2 bottom-2 size-8 rounded-[0.4rem]"
          >
            <ArrowUp />
          </Button>
        </form>

        <p className="mt-2.5 text-center text-xs text-muted-foreground">
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Enter</kbd> to send
          <span className="mx-1.5 text-border">·</span>
          <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Shift+Enter</kbd> for newline
        </p>
      </div>
    </div>
  )
}

export function ChatPanel() {
  const { activeId, activeConversation, createConversation } = useConversations()

  useEffect(() => {
    if (!activeId) createConversation()
  }, [activeId, createConversation])

  if (!activeId) return null

  return (
    <ActiveChat
      key={activeId}
      conversationId={activeId}
      initialMessages={activeConversation?.messages ?? []}
    />
  )
}
