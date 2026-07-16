import { useCallback, useEffect, useState } from "react"
import { CaretLeft, CaretRight, CircleNotch, FileText, WarningCircle, CheckCircle, Clock } from "@phosphor-icons/react"
import {
  fetchDistributionLists,
  fetchDistributionListItems,
  fetchDocuments,
  type DistributionListSummary,
  type DistributionListItem,
  type DocumentInfo,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/**
 * Document tab — registry-driven layout.
 *
 *   Layer 0: overall stats (already rendered by SyncPanel above this component)
 *   Layer 1: the list of distribution lists
 *   Layer 2: per-list document detail
 */
export function DistributionListsView({ refreshKey }: { refreshKey: number }) {
  const [lists, setLists] = useState<DistributionListSummary[] | null>(null)
  const [manualDocs, setManualDocs] = useState<DocumentInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      // Pasted-link docs belong to no distribution list, so they'd be
      // invisible in this list-centric view; fetch them alongside. A failure
      // there just leaves the section empty rather than erroring the tab.
      const [data, docs] = await Promise.all([
        fetchDistributionLists(),
        fetchDocuments().catch(() => [] as DocumentInfo[]),
      ])
      setLists(data)
      setManualDocs(docs.filter((d) => d.source === "manual-link"))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load lists")
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load, refreshKey])

  if (selectedId) {
    const list = lists?.find((l) => l.id === selectedId) ?? null
    return (
      <DistributionListDetailView
        list={list}
        onBack={() => setSelectedId(null)}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-sidebar-border px-4 py-2.5">
        <h3 className="label-eyebrow text-sidebar-foreground/60">
          Distribution lists
        </h3>
      </div>
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-sidebar-foreground/60">
          <CircleNotch className="mr-2 size-3.5 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {!lists || lists.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-sidebar-foreground/60">
              No distribution lists yet. Run a sync to discover them.
            </p>
          ) : (
            <ul className="flex flex-col">
              {lists.map((l) => (
                <li key={l.id}>
                  <DistributionListRow
                    list={l}
                    onClick={() => setSelectedId(l.id)}
                  />
                </li>
              ))}
            </ul>
          )}

          {manualDocs.length > 0 && (
            <>
              <div className="border-b border-sidebar-border px-4 py-2.5">
                <h3 className="label-eyebrow text-sidebar-foreground/60">
                  Pasted documents
                </h3>
              </div>
              <ul className="flex flex-col">
                {manualDocs.map((d) => (
                  <li key={d.id}>
                    <ManualDocRow doc={d} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One pasted-link document — visible to everyone, synced by the watcher. */
function ManualDocRow({ doc }: { doc: DocumentInfo }) {
  return (
    <div className="flex items-center gap-2 border-b border-sidebar-border/60 px-4 py-2 text-xs text-sidebar-foreground/85">
      <FileText className="size-3.5 shrink-0 text-sidebar-foreground/50" />
      <div className="min-w-0 flex-1">
        {doc.linkUrl ? (
          <a
            href={doc.linkUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate leading-snug hover:underline"
          >
            {doc.filename}
          </a>
        ) : (
          <span className="block truncate leading-snug">{doc.filename}</span>
        )}
      </div>
      <ItemStatus status={doc.syncStatus ?? "synced"} error={doc.syncError ?? null} />
    </div>
  )
}

function DistributionListRow({
  list,
  onClick,
}: {
  list: DistributionListSummary
  onClick: () => void
}) {
  const total = list.counters.synced + list.counters.pending + list.counters.failed
  const truncatedNote = list.note && list.note.length > 80 ? list.note.slice(0, 80) + "…" : list.note

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-start gap-2 border-b border-sidebar-border/60 px-4 py-2.5 text-left transition-colors hover:bg-sidebar-accent/60"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <StatusGlyph status={list.lastSyncStatus} />
          <span className="truncate text-sm font-medium text-sidebar-foreground">
            {list.displayName}
          </span>
        </div>
        {truncatedNote && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="line-clamp-2 text-[11px] text-sidebar-foreground/55">
                  {truncatedNote}
                </span>
              </TooltipTrigger>
              {list.note && list.note.length > 80 && (
                <TooltipContent className="max-w-xs">
                  {list.note}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="flex items-center gap-2 text-[10px] tabular-nums text-sidebar-foreground/60">
          <span>{total} docs</span>
          {list.counters.synced > 0 && (
            <span className="text-emerald-400">✓ {list.counters.synced}</span>
          )}
          {list.counters.pending > 0 && (
            <span className="text-amber-300">⏳ {list.counters.pending}</span>
          )}
          {list.counters.failed > 0 && (
            <span className="text-destructive">✗ {list.counters.failed}</span>
          )}
          {list.lastSyncedAt && (
            <span className="ml-auto">{formatRelative(list.lastSyncedAt)}</span>
          )}
        </div>
      </div>
      <CaretRight className="mt-1 size-4 shrink-0 text-sidebar-foreground/30" />
    </button>
  )
}

function DistributionListDetailView({
  list,
  onBack,
}: {
  list: DistributionListSummary | null
  onBack: () => void
}) {
  const [items, setItems] = useState<DistributionListItem[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)

  const loadInitial = useCallback(async () => {
    if (!list) return
    setIsLoading(true)
    setError(null)
    try {
      const data = await fetchDistributionListItems(list.id)
      setItems(data.items)
      setCursor(data.nextCursor)
      setHasMore(Boolean(data.nextCursor))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load items")
    } finally {
      setIsLoading(false)
    }
  }, [list])

  const loadMore = async () => {
    if (!list || !cursor) return
    try {
      const data = await fetchDistributionListItems(list.id, { cursor })
      setItems((prev) => [...prev, ...data.items])
      setCursor(data.nextCursor)
      setHasMore(Boolean(data.nextCursor))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more")
    }
  }

  useEffect(() => { loadInitial() }, [loadInitial])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-sidebar-border px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="mb-1 flex items-center gap-1 text-[11px] text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
        >
          <CaretLeft className="size-3.5" /> All lists
        </button>
        <h3 className="text-sm font-semibold text-sidebar-foreground">
          {list?.displayName ?? "List"}
        </h3>
        {list?.note && (
          <p className="mt-1 text-[11px] leading-snug text-sidebar-foreground/55">
            {list.note}
          </p>
        )}
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-xs text-sidebar-foreground/60">
          <CircleNotch className="mr-2 size-3.5 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
      ) : items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-sidebar-foreground/60">
          No items synced for this list yet.
        </p>
      ) : (
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col className="w-full" />
              <col className="w-11" />
              <col className="w-[4.75rem]" />
            </colgroup>
            <thead className="sticky top-0 bg-sidebar text-[10px] uppercase text-sidebar-foreground/60">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Document</th>
                <th className="px-1 py-2 text-left font-medium">Ver</th>
                <th className="px-1.5 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const identity = `${it.sharepointCode} - ${it.sharepointTitle}`

                return (
                  <tr
                    key={it.id}
                    className="border-t border-sidebar-border/60 align-top text-sidebar-foreground/85"
                  >
                    <td className="min-w-0 px-4 py-1.5">
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div tabIndex={0} className="min-w-0 outline-none">
                              <span className="block truncate leading-snug">
                                {it.sharepointTitle}
                              </span>
                              <span className="block truncate font-mono text-[11px] leading-snug tabular-nums text-sidebar-foreground/55">
                                {it.sharepointCode}
                              </span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-sm break-words text-[11px]">
                            {identity}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                    <td className="px-1 py-1.5 font-mono text-[11px] tabular-nums">
                      <span className="block truncate">{it.sharepointVersion || "—"}</span>
                    </td>
                    <td className="px-1.5 py-1.5">
                      <ItemStatus status={it.syncStatus} error={it.syncError} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {hasMore && (
            <div className="flex items-center justify-center py-3">
              <button
                type="button"
                onClick={loadMore}
                className="text-xs text-sidebar-foreground/70 underline hover:text-sidebar-foreground"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusGlyph({ status }: { status: string }) {
  if (status === "ok") return <CheckCircle className="size-3.5 text-emerald-500" />
  if (status === "partial") return <WarningCircle className="size-3.5 text-amber-500" />
  if (status === "unresolvable" || status === "removed") return <WarningCircle className="size-3.5 text-destructive" />
  if (status === "error") return <WarningCircle className="size-3.5 text-destructive" />
  return <Clock className="size-3.5 text-sidebar-foreground/40" />
}

function ItemStatus({ status, error }: { status: string; error: string | null }) {
  const labelColor = cn(
    status === "synced" && "text-emerald-400",
    status === "pending_access" && "text-amber-300",
    status === "failed_parse" && "text-destructive",
    status === "failed_resolve" && "text-destructive",
    status === "pending" && "text-sidebar-foreground/60",
  )
  const inner = (
    <span className={cn("font-mono text-[10px] uppercase tracking-wider", labelColor)}>
      {status.replace(/_/g, " ")}
    </span>
  )
  if (!error) return inner
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent className="max-w-xs text-[11px]">{error}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
