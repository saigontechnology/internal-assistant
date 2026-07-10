import { useCallback, useEffect, useState } from "react"
import { AlertCircle, RefreshCw, Trash2, ExternalLink, Loader2 } from "lucide-react"
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Documents</h1>
          <p className="text-sm text-muted-foreground">
            Every indexed document, unfiltered by job profile.
          </p>
        </div>
        <Button onClick={doFullSync} disabled={syncing}>
          {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {syncing ? "Syncing…" : "Run full sync"}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search filename or code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-xs"
        />
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
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      ) : !docs ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <p className="rounded-md border border-border p-8 text-center text-sm text-muted-foreground">
          No documents match.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead>Lists</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {docs.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
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
                            <ExternalLink className="size-3.5" />
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
                              <AlertCircle className="size-3.5 text-destructive" />
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
                                <RefreshCw />
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
                              <Trash2 className="text-destructive" />
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
          </div>

          {nextCursor && (
            <div className="flex justify-center">
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
