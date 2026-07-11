import { useCallback, useEffect, useState } from "react"
import {
  WarningCircle,
  DownloadSimple,
  ArrowSquareOut,
  CircleNotch,
  PencilSimple,
  Plus,
  ArrowsClockwise,
  Trash,
  LinkSimple,
  CheckCircle,
  WarningDiamond,
} from "@phosphor-icons/react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
  createAdminList,
  deleteAdminList,
  fetchAdminLists,
  importRegistry,
  syncAdminList,
  updateAdminList,
  type AdminList,
} from "@/lib/admin-api"
import { ErrorBanner, PageHeader, Panel, StatCard } from "./admin-ui"

export function AdminLinksPage() {
  const [lists, setLists] = useState<AdminList[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [editing, setEditing] = useState<AdminList | "new" | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AdminList | null>(null)

  const load = useCallback(async () => {
    try {
      setLists(await fetchAdminLists())
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleEnabled = async (list: AdminList, enabled: boolean) => {
    setBusy(list.id)
    try {
      await updateAdminList(list.id, { enabled })
      toast.success(
        enabled
          ? `${list.displayName} enabled`
          : `${list.displayName} disabled — its documents drop out of retrieval on the next sync`,
      )
      await load()
    } catch (err) {
      toast.error((err as Error).message)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const doSync = async (list: AdminList) => {
    setBusy(list.id)
    try {
      const summary = await syncAdminList(list.id)
      const c = summary.counters
      if (summary.status === "unresolvable") {
        toast.error(summary.fatalError ?? "List URL could not be resolved")
      } else {
        toast.success(
          `${list.displayName}: ${c.ingested + c.updated} ingested, ${c.skipped} unchanged, ` +
            `${c.failed} failed`,
        )
      }
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const doDelete = async (list: AdminList) => {
    setBusy(list.id)
    try {
      const { message } = await deleteAdminList(list.id)
      toast.success(message)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      setConfirmDelete(null)
    }
  }

  const doImport = async () => {
    setImporting(true)
    try {
      const r = await importRegistry()
      toast.success(
        `Imported ${r.rowsSeen} registry rows: ${r.created} new, ${r.updated} refreshed` +
          (r.unresolved ? `, ${r.unresolved} unresolvable` : ""),
      )
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setImporting(false)
    }
  }

  const enabledCount = lists?.filter((l) => l.enabled).length ?? 0
  const unresolvedCount = lists?.filter((l) => !l.targetListId).length ?? 0

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Sync sources"
        title="Document links"
        description="Each link points at a SharePoint list whose rows are synced into the index. These rows are the source of truth — the old “Document Distribution List” registry in SharePoint is no longer read."
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" onClick={doImport} disabled={importing}>
                  {importing ? <CircleNotch className="animate-spin" /> : <DownloadSimple />}
                  Import registry
                </Button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                One-shot migration: copies rows from the legacy SharePoint registry list into
                the database. Safe to run more than once.
              </TooltipContent>
            </Tooltip>
            <Button onClick={() => setEditing("new")}>
              <Plus />
              Add link
            </Button>
          </>
        }
      />

      {lists && lists.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Links" value={lists.length} icon={LinkSimple} />
          <StatCard label="Enabled" value={enabledCount} icon={CheckCircle} tone="primary" />
          <StatCard
            label="Unresolved"
            value={unresolvedCount}
            hint={unresolvedCount ? "URL not resolvable" : "all resolved"}
            icon={WarningDiamond}
            tone={unresolvedCount ? "destructive" : "default"}
          />
        </div>
      )}

      {error ? (
        <ErrorBanner>
          <WarningCircle className="size-4 shrink-0" />
          {error}
        </ErrorBanner>
      ) : !lists ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : lists.length === 0 ? (
        <Panel className="p-10 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <LinkSimple className="size-5" />
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            No document links yet. Nothing will sync until you add one.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button variant="outline" onClick={doImport} disabled={importing}>
              Import from SharePoint registry
            </Button>
            <Button onClick={() => setEditing("new")}>Add link</Button>
          </div>
        </Panel>
      ) : (
        <Panel className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>SharePoint list URL</TableHead>
                <TableHead>Last sync</TableHead>
                <TableHead className="text-center">Enabled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.map((l) => (
                <TableRow key={l.id} className={l.enabled ? "" : "opacity-55"}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{l.displayName}</div>
                    {l.note && (
                      <div className="max-w-xs truncate text-xs text-muted-foreground">
                        {l.note}
                      </div>
                    )}
                  </TableCell>

                  <TableCell>
                    <a
                      href={l.listUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex max-w-sm items-center gap-1 truncate text-sm text-muted-foreground hover:text-foreground"
                    >
                      <span className="truncate">{l.listUrl}</span>
                      <ArrowSquareOut className="size-3 shrink-0" />
                    </a>
                    {!l.targetListId && (
                      <Badge variant="destructive" className="mt-1">
                        unresolved
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={l.lastSyncStatus === "ok" ? "default" : "secondary"}>
                        {l.lastSyncStatus}
                      </Badge>
                      {l.lastSyncError && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <WarningCircle className="size-3.5 text-destructive" />
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">{l.lastSyncError}</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {l.counters.synced} synced
                      {l.counters.failed > 0 && ` · ${l.counters.failed} failed`}
                    </span>
                  </TableCell>

                  <TableCell className="text-center">
                    <Switch
                      checked={l.enabled}
                      disabled={busy === l.id}
                      onCheckedChange={(next) => toggleEnabled(l, next)}
                      aria-label="Enabled"
                    />
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy === l.id || !l.enabled}
                            onClick={() => doSync(l)}
                            aria-label="Sync now"
                          >
                            {busy === l.id ? (
                              <CircleNotch className="animate-spin" />
                            ) : (
                              <ArrowsClockwise />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Sync this list now</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy === l.id}
                            onClick={() => setEditing(l)}
                            aria-label="Edit"
                          >
                            <PencilSimple />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={busy === l.id}
                            onClick={() => setConfirmDelete(l)}
                            aria-label="Delete"
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
      )}

      {editing && (
        <LinkDialog
          list={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
          }}
        />
      )}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The link and its document roster are removed. The documents themselves stay in
              the index until the next full sync, which drops them out of chat retrieval. To
              stop syncing without losing the row, disable it instead.
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

function LinkDialog({
  list,
  onClose,
  onSaved,
}: {
  list: AdminList | null
  onClose: () => void
  onSaved: () => void | Promise<void>
}) {
  const [displayName, setDisplayName] = useState(list?.displayName ?? "")
  const [note, setNote] = useState(list?.note ?? "")
  const [listUrl, setListUrl] = useState(list?.listUrl ?? "")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const save = async () => {
    setSaving(true)
    setFormError(null)
    try {
      if (list) {
        await updateAdminList(list.id, { displayName, note: note || null, listUrl })
        toast.success("Link updated")
      } else {
        await createAdminList({ displayName, note: note || null, listUrl })
        toast.success("Link added")
      }
      await onSaved()
    } catch (err) {
      // Surfaced inline rather than as a toast: it's almost always a bad URL
      // or a permissions problem the admin needs to fix in this form.
      setFormError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{list ? "Edit link" : "Add document link"}</DialogTitle>
          <DialogDescription>
            The URL is resolved against SharePoint when you save, using your own access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName">Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="ISO Procedures"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="listUrl">SharePoint list URL</Label>
            <Input
              id="listUrl"
              value={listUrl}
              onChange={(e) => setListUrl(e.target.value)}
              placeholder="https://contoso.sharepoint.com/sites/QA/Lists/Procedures"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note">Note (optional)</Label>
            <Textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
          </div>

          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <WarningCircle className="mt-0.5 size-4 shrink-0" />
              {formError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button disabled={saving || !displayName.trim() || !listUrl.trim()} onClick={save}>
            {saving && <CircleNotch className="animate-spin" />}
            {list ? "Save" : "Add link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
