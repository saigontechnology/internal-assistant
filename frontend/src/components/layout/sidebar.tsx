import { useState, useEffect, useCallback, useRef } from "react"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { SyncPanel } from "@/components/documents/sync-panel"
import { DistributionListsView } from "@/components/documents/distribution-lists-view"
import { useConversations } from "@/lib/conversations"
import { useAppView } from "@/lib/app-view"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { BookOpen, MessageSquarePlus, Trash2, MessageSquare, X } from "lucide-react"
import { cn } from "@/lib/utils"
import logoUrlWhite from "@/assets/logo_white.svg"

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
  const { setView, closeSidebar } = useAppView()

  return (
    <div className="flex flex-col gap-2">
      <Button
        size="sm"
        className="w-full justify-start gap-2"
        onClick={() => {
          createConversation()
          setView("chat")
          closeSidebar()
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
                closeSidebar()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  selectConversation(conv.id)
                  setView("chat")
                  closeSidebar()
                }
              }}
              className={cn(
                "group relative flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
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
              <span className="shrink-0 text-[10px] text-sidebar-foreground/50">
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
  const [showTabs, setShowTabs] = useState(false)
  const [localRefresh, setLocalRefresh] = useState(0)
  const logoClicksRef = useRef<number[]>([])
  const { docsRefreshToken, isSidebarOpen, closeSidebar } = useAppView()

  useEffect(() => {
    if (!isSidebarOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSidebar()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isSidebarOpen, closeSidebar])

  const handleLogoClick = () => {
    const now = Date.now()
    logoClicksRef.current = [...logoClicksRef.current, now].filter(
      (t) => now - t <= 3000
    )
    if (logoClicksRef.current.length >= 10) {
      setShowTabs((prev) => !prev)
      logoClicksRef.current = []
    }
  }

  const bumpRefresh = useCallback(() => setLocalRefresh((n) => n + 1), [])

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        // Mobile: slide-in drawer over content. Desktop (md+): inline in flow.
        "fixed inset-y-0 left-0 z-50 w-[19rem] max-w-[85vw] transform transition-transform duration-200 ease-out shadow-xl lg:static lg:z-auto lg:w-auto lg:max-w-none lg:translate-x-0 lg:shadow-none",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
      )}
      aria-hidden={!isSidebarOpen}
    >
      <div className="flex h-16 items-center gap-2.5 border-b border-sidebar-border px-4">
        <img
          src={logoUrlWhite}
          alt="Internal Assistant"
          className="h-8 w-auto shrink-0"
          onClick={handleLogoClick}
          draggable={false}
        />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold tracking-wide">
            INTERNAL ASSISTANT
          </span>
          <span className="text-[10px] font-medium tracking-[0.15em] text-sidebar-foreground/60 uppercase">
            Document Room
          </span>
        </div>
        <button
          type="button"
          onClick={closeSidebar}
          aria-label="Close sidebar"
          className="ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:hidden"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {showTabs && (
        <TooltipProvider>
          <nav className="flex w-12 flex-col items-center gap-1 border-r border-sidebar-border py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setActiveTab("chats")}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg transition-colors",
                    activeTab === "chats"
                      ? "bg-sidebar-primary/20 text-sidebar-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
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
                      ? "bg-sidebar-primary/20 text-sidebar-primary"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  )}
                >
                  <BookOpen className="size-5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Documents</TooltipContent>
            </Tooltip>
          </nav>
        </TooltipProvider>
        )}

        <div className="flex w-full min-w-0 flex-1 flex-col lg:w-72 lg:flex-none">
          {activeTab === "chats" ? (
          <>
            <div className="flex items-center gap-2 px-4 py-4">
              <h2 className="label-eyebrow text-sidebar-foreground/60">Chats</h2>
            </div>
            <Separator />
            <div className="flex-1 overflow-y-auto px-4 py-3">
              <ConversationList />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-4 py-4">
              <h2 className="label-eyebrow text-sidebar-foreground/60">Documents Vault</h2>
            </div>
            <Separator />
            {/* Three stacked regions:
                  - SyncPanel (Layer 0 — overall stats + Sync button)
                  - DistributionListsView Layer 1 (list of distribution lists)
                  - DistributionListsView Layer 2 (per-list items, when one is selected) */}
            <div className="shrink-0 p-4 pb-3">
              <SyncPanel onSyncComplete={bumpRefresh} />
            </div>
            <Separator />
            <DistributionListsView refreshKey={docsRefreshToken + localRefresh} />
          </>
        )}
        </div>
      </div>
    </aside>
  )
}
