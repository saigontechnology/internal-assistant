import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import type { UIMessage } from "ai"
import { uuid } from "./utils"

const STORAGE_KEY = "internal-assistant:conversations"
const LEGACY_STORAGE_KEY = "docwise:conversations"
const MAX_CONVERSATIONS = 50

export interface StoredConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: UIMessage[]
}

interface ConversationContextValue {
  conversations: StoredConversation[]
  activeId: string | null
  activeConversation: StoredConversation | null
  createConversation: () => string
  selectConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  saveMessages: (id: string, messages: UIMessage[]) => void
}

const ConversationContext = createContext<ConversationContextValue | null>(null)

function readFromStorage(): StoredConversation[] {
  try {
    let raw = localStorage.getItem(STORAGE_KEY)
    // One-time migration from the legacy "docwise:conversations" key.
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
      if (legacy !== null) {
        localStorage.setItem(STORAGE_KEY, legacy)
        localStorage.removeItem(LEGACY_STORAGE_KEY)
        raw = legacy
      }
    }
    if (!raw) return []
    return JSON.parse(raw) as StoredConversation[]
  } catch {
    return []
  }
}

function writeToStorage(conversations: StoredConversation[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
}

function autoTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return "New chat"
  const text = firstUser.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
  return text.slice(0, 50) || "New chat"
}

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<StoredConversation[]>(
    readFromStorage
  )
  const [activeId, setActiveId] = useState<string | null>(
    () => conversations[0]?.id ?? null
  )

  const persist = useCallback((next: StoredConversation[]) => {
    const trimmed =
      next.length > MAX_CONVERSATIONS
        ? next.slice(0, MAX_CONVERSATIONS)
        : next
    setConversations(trimmed)
    writeToStorage(trimmed)
  }, [])

  const createConversation = useCallback(() => {
    const active = conversations.find((c) => c.id === activeId)
    if (active && active.messages.length === 0) {
      setActiveId(active.id)
      return active.id
    }

    const id = uuid()
    const now = Date.now()
    const conv: StoredConversation = {
      id,
      title: "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
    }
    persist([conv, ...conversations])
    setActiveId(id)
    return id
  }, [conversations, activeId, persist])

  const selectConversation = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  const deleteConversation = useCallback(
    (id: string) => {
      const next = conversations.filter((c) => c.id !== id)
      persist(next)
      if (activeId === id) {
        setActiveId(next[0]?.id ?? null)
      }
    },
    [conversations, activeId, persist]
  )

  const renameConversation = useCallback(
    (id: string, title: string) => {
      const next = conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      )
      persist(next)
    },
    [conversations, persist]
  )

  const saveMessages = useCallback(
    (id: string, messages: UIMessage[]) => {
      const existing = conversations.find((c) => c.id === id)
      if (!existing) return

      const needsAutoTitle =
        existing.title === "New chat" &&
        messages.some((m) => m.role === "user")

      const updated: StoredConversation = {
        ...existing,
        messages,
        updatedAt: Date.now(),
        title: needsAutoTitle ? autoTitle(messages) : existing.title,
      }

      const next = [
        updated,
        ...conversations.filter((c) => c.id !== id),
      ]
      persist(next)
    },
    [conversations, persist]
  )

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  )

  const value = useMemo<ConversationContextValue>(
    () => ({
      conversations,
      activeId,
      activeConversation,
      createConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      saveMessages,
    }),
    [
      conversations,
      activeId,
      activeConversation,
      createConversation,
      selectConversation,
      deleteConversation,
      renameConversation,
      saveMessages,
    ]
  )

  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  )
}

export function useConversations() {
  const ctx = useContext(ConversationContext)
  if (!ctx) {
    throw new Error("useConversations must be used within ConversationProvider")
  }
  return ctx
}
