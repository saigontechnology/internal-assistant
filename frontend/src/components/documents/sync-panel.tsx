import { useEffect, useRef, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react"
import {
  fetchSyncStatus,
  triggerSync,
  type SyncStatusResponse,
  type SyncRun,
} from "@/lib/api"
import { cn } from "@/lib/utils"

interface SyncPanelProps {
  onSyncComplete: () => void
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never"
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

export function SyncPanel({ onSyncComplete }: SyncPanelProps) {
  const [status, setStatus] = useState<SyncStatusResponse | null>(null)
  const [isLoadingStatus, setIsLoadingStatus] = useState(true)
  const [isSyncing, setIsSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const s = await fetchSyncStatus()
      setStatus(s)
      // If the server reports a running sync (e.g. cron in Phase B, or a
      // sync started by another browser tab), reflect that here too.
      if (s.running && !isSyncing) setIsSyncing(true)
      if (!s.running && isSyncing && !abortRef.current) {
        // Server finished but we never knew we started it (cross-tab case).
        setIsSyncing(false)
        onSyncComplete()
      }
    } catch {
      // Probably not signed in — let the auth gate handle it; don't spam errors.
    } finally {
      setIsLoadingStatus(false)
    }
  }, [isSyncing, onSyncComplete])

  // Initial load + a slow poll so the "last sync" timer stays fresh.
  useEffect(() => {
    loadStatus()
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      if (abortRef.current) abortRef.current.abort()
    }
  }, [loadStatus])

  // Faster polling while a sync is in flight.
  useEffect(() => {
    if (!isSyncing) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
      return
    }
    pollRef.current = window.setInterval(loadStatus, 5000)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [isSyncing, loadStatus])

  const startSync = async () => {
    setError(null)
    setIsSyncing(true)
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const result: SyncRun = await triggerSync(ctrl.signal)
      setStatus((prev) => prev ? { ...prev, lastRun: result, running: false } : prev)
      onSyncComplete()
      // refresh full status so indexState picks up
      await loadStatus()
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(err instanceof Error ? err.message : "Sync failed")
    } finally {
      setIsSyncing(false)
      abortRef.current = null
    }
  }

  const indexState = status?.indexState
  const lastRun = status?.lastRun
  const persisted = status?.persistedState

  const total = indexState
    ? indexState.synced + indexState.pending_access + indexState.failed_parse + indexState.failed_resolve
    : 0

  return (
    <div className="dark flex flex-col gap-3 text-foreground">
      <div className="rounded-lg border border-border bg-card/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label-eyebrow text-muted-foreground">SharePoint List</span>
          {persisted?.lastRunAt && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {formatRelative(persisted.lastRunAt)}
            </span>
          )}
        </div>

        {/* Status counts — empty state when nothing's synced yet. */}
        {isLoadingStatus ? (
          <div className="flex h-10 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 size-3.5 animate-spin" /> Loading…
          </div>
        ) : total === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No syncs yet — click below to fetch the list.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            <StatusBadge tone="ok" count={indexState!.synced} label="synced" />
            {indexState!.pending_access > 0 && (
              <StatusBadge tone="muted" count={indexState!.pending_access} label="pending" />
            )}
            {(indexState!.failed_parse + indexState!.failed_resolve) > 0 && (
              <StatusBadge
                tone="error"
                count={indexState!.failed_parse + indexState!.failed_resolve}
                label="failed"
              />
            )}
            <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
              {total} total
            </span>
          </div>
        )}
      </div>

      <Button
        onClick={startSync}
        disabled={isSyncing}
        className="w-full gap-2"
        size="sm"
      >
        {isSyncing ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Syncing…
          </>
        ) : (
          <>
            <RefreshCw className="size-4" />
            Sync now
          </>
        )}
      </Button>

      {isSyncing && (
        <p className="text-center text-xs text-muted-foreground">
          This usually takes a few minutes. You can keep using the chat while it runs.
        </p>
      )}

      {/* Last-run summary collapses to a single line. */}
      {lastRun && !isSyncing && (
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            {lastRun.status === "ok" ? (
              <CheckCircle2 className="size-3.5 text-emerald-500" />
            ) : lastRun.status === "partial" ? (
              <AlertCircle className="size-3.5 text-amber-500" />
            ) : (
              <AlertCircle className="size-3.5 text-destructive" />
            )}
            <span className="font-medium capitalize text-foreground/80">{lastRun.status}</span>
            <span>· {formatDuration(lastRun.durationMs)}</span>
          </div>
          <div className="mt-1 text-[11px] leading-snug">
            {lastRun.counters.ingested + lastRun.counters.updated} ingested
            {" · "}
            {lastRun.counters.skipped} unchanged
            {lastRun.counters.failed > 0 && <> · <span className="text-destructive">{lastRun.counters.failed} failed</span></>}
            {lastRun.counters.removed > 0 && <> · {lastRun.counters.removed} removed</>}
          </div>
          {lastRun.fatalError && (
            <p className="mt-1 truncate text-[11px] text-destructive" title={lastRun.fatalError}>
              {lastRun.fatalError}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  )
}

function StatusBadge({
  tone,
  count,
  label,
}: {
  tone: "ok" | "muted" | "error"
  count: number
  label: string
}) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 font-mono text-[11px] tabular-nums",
        tone === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {count} <span className="font-sans font-normal">{label}</span>
    </Badge>
  )
}
