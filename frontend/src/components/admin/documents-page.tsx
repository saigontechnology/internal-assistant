import { useCallback, useEffect, useState } from "react"
import {
  WarningCircle,
  ArrowsClockwise,
  Trash,
  ArrowSquareOut,
  CircleNotch,
  FileText,
  Stack,
  Clock,
  MagnifyingGlass,
} from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  deleteAdminDocument,
  fetchAdminDocuments,
  resyncAdminDocument,
  runFullSync,
  type AdminDocument,
} from "@/lib/admin-api"
import { ErrorBanner, PageHeader, Panel, StatCard } from "./admin-ui"

const STATUSES = [
  { value: "all", label: "All statuses" },
  { value: "synced", label: "Synced" },
  { value: "pending_access", label: "Pending access" },
  { value: "failed_parse", label: "Failed parse" },
  { value: "failed_resolve", label: "Failed resolve" },
]

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "synced") return "default"
  if (status === "pending_access") return "secondary"
  return "destructive"
}

export function AdminDocumentsPage() {
  const [docs, setDocs] = useState<AdminDocument[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("all")
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<AdminDocument | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetchAdminDocuments({
        q: q || undefined,
        status: status === "all" ? undefined : status,
      })
      setDocs(res.documents)
      setNextCursor(res.nextCursor)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [q, status])

  // Debounced so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(), 250)
    return () => clearTimeout(t)
  }, [load])

  const loadMore = async () => {
    if (!nextCursor) return
    try {
      const res = await fetchAdminDocuments({
        q: q || undefined,
        status: status === "all" ? undefined : status,
        cursor: nextCursor,
      })
      setDocs((prev) => [...(prev ?? []), ...res.documents])
      setNextCursor(res.nextCursor)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const doDelete = async (doc: AdminDocument) => {
    setBusy(doc.id)
    try {
      await deleteAdminDocument(doc.id)
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== doc.id))
      toast.success(`Deleted ${doc.filename}`)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      setConfirmDelete(null)
    }
  }

  const doResync = async (doc: AdminDocument) => {
    setBusy(doc.id)
    try {
      const { message } = await resyncAdminDocument(doc.id)
      toast.success(message)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const doFullSync = async () => {
    setSyncing(true)
    try {
      const run = await runFullSync()
      toast.success(
        `Sync ${run.status}: ${run.totals.ingested + run.totals.updated} ingested, ` +
          `${run.totals.skipped} unchanged, ${run.totals.failed} failed`,
      )
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSyncing(false)
    }
  }

  const totalChunks = docs?.reduce((sum, d) => sum + d.chunkCount, 0) ?? 0
  const pendingCount = docs?.filter((d) => d.syncStatus !== "synced").length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col gap-6">
      <PageHeader
        eyebrow="Knowledge base"
        title="Documents"
        description="Every indexed document, unfiltered by job profile."
        actions={
          <Button onClick={doFullSync} disabled={syncing}>
            {syncing ? <CircleNotch className="animate-spin" /> : <ArrowsClockwise />}
            {syncing ? "Syncing…" : "Run full sync"}
          </Button>
        }
      />

      {docs && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Documents" value={docs.length} icon={FileText} />
          <StatCard label="Embedding chunks" value={totalChunks} icon={Stack} tone="primary" />
          <StatCard
            label="Needs attention"
            value={pendingCount}
            hint={pendingCount ? "not fully synced" : "all synced"}
            icon={Clock}
            tone={pendingCount ? "destructive" : "default"}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <div className="relative max-w-xs flex-1">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search filename or code…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <ErrorBanner>
          <WarningCircle className="size-4 shrink-0" />
          {error}
        </ErrorBanner>
      ) : !docs ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <Panel className="p-10 text-center text-sm text-muted-foreground">
          No documents match.
        </Panel>
      ) : (
        <>
          <Panel className="min-h-0 flex-1">
            <Table containerClassName="h-full">
              <TableHeader sticky className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Document</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead>Lists</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-2">
                        <span className="max-w-xs truncate font-medium">{d.filename}</span>
                        {d.sharepointUrl && (
                          <a
                            href={d.sharepointUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground"
                            aria-label="Open in SharePoint"
                          >
                            <ArrowSquareOut className="size-3.5" />
                          </a>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {d.sharepointCode ?? d.source}
                        {d.sharepointVersion && ` · v${d.sharepointVersion}`}
                      </span>
                    </TableCell>

                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={statusVariant(d.syncStatus)}>{d.syncStatus}</Badge>
                        {d.syncError && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <WarningCircle className="size-3.5 text-destructive" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-sm">{d.syncError}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-right tabular-nums">{d.chunkCount}</TableCell>

                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {d.lists.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          d.lists.map((l) => (
                            <Badge key={l.id} variant="outline">
                              {l.displayName}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {d.sharepointCode && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={busy === d.id}
                                onClick={() => doResync(d)}
                                aria-label="Re-download on next sync"
                              >
                                <ArrowsClockwise />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Re-download on next sync</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy === d.id}
                              onClick={() => setConfirmDelete(d)}
                              aria-label="Delete document"
                            >
                              <Trash className="text-destructive" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Delete</TooltipContent>
                        </Tooltip>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          {nextCursor && (
            <div className="flex shrink-0 justify-center">
              <Button variant="outline" onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.filename} and its {confirmDelete?.chunkCount} embedding chunks
              are removed from the index. If it still exists in its SharePoint list, the next
              sync will re-ingest it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && doDelete(confirmDelete)}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
