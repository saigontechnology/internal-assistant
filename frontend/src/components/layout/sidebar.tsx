import { useState, useEffect, useCallback } from "react"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { UploadZone } from "@/components/documents/upload-zone"
import { DocumentList } from "@/components/documents/document-list"
import { fetchDocuments, deleteDocument, type DocumentInfo } from "@/lib/api"
import { useConversations } from "@/lib/conversations"
import { useAppView } from "@/lib/app-view"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BookOpen, MessageSquarePlus, Trash2, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"

type SidebarTab = "chats" | "documents"

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function ConversationList() {
  const {
    conversations,
    activeId,
    createConversation,
    selectConversation,
    deleteConversation,
  } = useConversations()
  const { setView } = useAppView()

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => {
          createConversation()
          setView("chat")
        }}
      >
        <MessageSquarePlus className="size-4" />
        New chat
      </Button>

      {conversations.length === 0 && (
        <p className="py-3 text-center text-xs text-muted-foreground">
          No conversations yet
        </p>
      )}

      <div className="flex flex-col gap-0.5">
        {conversations.map((conv) => {
          const isActive = conv.id === activeId
          return (
            <div
              key={conv.id}
              role="button"
              tabIndex={0}
              onClick={() => {
                selectConversation(conv.id)
                setView("chat")
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  selectConversation(conv.id)
                  setView("chat")
                }
              }}
              className={cn(
                "group relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-primary/5 text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              {isActive && (
                <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" />
              )}
              <MessageSquare
                className={cn(
                  "size-3.5 shrink-0",
                  isActive && "text-primary"
                )}
              />
              <span className="flex-1 truncate">{conv.title}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {timeAgo(conv.updatedAt)}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  deleteConversation(conv.id)
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Sidebar() {
  const [activeTab, setActiveTab] = useState<SidebarTab>("chats")
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const { docsRefreshToken } = useAppView()

  const loadDocuments = useCallback(async () => {
    try {
      setIsLoading(true)
      const docs = await fetchDocuments()
      setDocuments(docs)
    } catch {
      // silently handle - documents panel will show empty state
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDocuments()
  }, [loadDocuments, docsRefreshToken])

  const handleDelete = async (docId: string) => {
    try {
      await deleteDocument(docId)
      setDocuments((prev) => prev.filter((d) => d.id !== docId))
    } catch {
      // could add toast here
    }
  }

  return (
    <aside className="flex h-full border-r border-border bg-card">
      <TooltipProvider>
        <nav className="flex w-12 flex-col items-center gap-1 border-r border-border py-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setActiveTab("chats")}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg transition-colors",
                  activeTab === "chats"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <MessageSquare className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Chats</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setActiveTab("documents")}
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg transition-colors",
                  activeTab === "documents"
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <BookOpen className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Documents</TooltipContent>
          </Tooltip>
        </nav>
      </TooltipProvider>

      <div className="flex w-72 flex-col">
        {activeTab === "chats" ? (
          <>
            <div className="flex items-center gap-2 px-4 py-4">
              <h2 className="label-eyebrow text-muted-foreground">Chats</h2>
            </div>
            <Separator />
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ConversationList />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-4">
              <h2 className="label-eyebrow text-muted-foreground">Documents</h2>
              <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
                {String(documents.length).padStart(2, "0")} file
                {documents.length !== 1 ? "s" : ""}
              </span>
            </div>
            <Separator />
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-4">
                <UploadZone onUploadComplete={loadDocuments} />
                <Separator />
                <DocumentList
                  documents={documents}
                  isLoading={isLoading}
                  onDelete={handleDelete}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
