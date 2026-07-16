import { useState, useCallback, useEffect } from "react"
import { Button } from "@/components/ui/button"
import {
  Cloud,
  FolderOpen,
  Folder,
  FileText,
  Check,
  CircleNotch,
  CaretLeft,
  CaretRight,
  LinkSimple,
  MagnifyingGlass,
  WarningCircle,
  X,
} from "@phosphor-icons/react"
import {
  fetchSharePointSites,
  fetchSharePointDrives,
  fetchSharePointFiles,
  fetchSharePointSearch,
  importDocuments,
  importDocumentLinks,
  type SharePointSite,
  type SharePointDrive,
  type SharePointFile,
  type SharePointFileRef,
} from "@/lib/api"
import { useAppView } from "@/lib/app-view"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

type Step = "search" | "sites" | "drives" | "files"
type Crumb = { id: string; name: string }

const PAGE_SIZE = 50

export function SharePointBrowser() {
  const { setView, refreshDocuments } = useAppView()
  const [step, setStep] = useState<Step>("search")
  const [isLoading, setIsLoading] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Search state
  const [queryInput, setQueryInput] = useState("")
  const [searchTerm, setSearchTerm] = useState("")
  const [searchResults, setSearchResults] = useState<SharePointFile[]>([])
  const [searchFrom, setSearchFrom] = useState(0)
  const [moreAvailable, setMoreAvailable] = useState(false)

  // Browse state
  const [sites, setSites] = useState<SharePointSite[]>([])
  const [drives, setDrives] = useState<SharePointDrive[]>([])
  const [files, setFiles] = useState<SharePointFile[]>([])
  const [selectedSite, setSelectedSite] = useState<SharePointSite | null>(null)
  const [selectedDrive, setSelectedDrive] = useState<SharePointDrive | null>(null)
  const [folderStack, setFolderStack] = useState<Crumb[]>([])

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [showAddLinks, setShowAddLinks] = useState(false)

  const runSearch = useCallback(async (query: string, from: number) => {
    setError(null)
    setIsLoading(true)
    try {
      const { files: results, moreAvailable: more } = await fetchSharePointSearch(query, from)
      setSearchTerm(query)
      setSearchFrom(from)
      setMoreAvailable(more)
      setSearchResults((prev) => (from === 0 ? results : [...prev, ...results]))
      if (from === 0) setSelectedFiles(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadSites = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    setSelectedFiles(new Set())
    try {
      const result = await fetchSharePointSites()
      setSites(result)
      setStep("sites")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sites")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadDrives = useCallback(async (site: SharePointSite) => {
    setError(null)
    setIsLoading(true)
    setSelectedSite(site)
    try {
      const result = await fetchSharePointDrives(site.id)
      setDrives(result)
      setStep("drives")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load drives")
    } finally {
      setIsLoading(false)
    }
  }, [])

  const loadFolderContents = useCallback(
    async (site: SharePointSite, drive: SharePointDrive, folderId?: string) => {
      setError(null)
      setIsLoading(true)
      setSelectedFiles(new Set())
      try {
        const result = await fetchSharePointFiles(site.id, drive.id, folderId)
        setFiles(sortItems(result))
        setStep("files")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load files")
      } finally {
        setIsLoading(false)
      }
    },
    []
  )

  const openDrive = useCallback(
    (drive: SharePointDrive) => {
      if (!selectedSite) return
      setSelectedDrive(drive)
      setFolderStack([])
      void loadFolderContents(selectedSite, drive)
    },
    [selectedSite, loadFolderContents]
  )

  const openFolder = useCallback(
    (folder: SharePointFile) => {
      if (!selectedSite || !selectedDrive) return
      setFolderStack((prev) => [...prev, { id: folder.id, name: folder.name }])
      void loadFolderContents(selectedSite, selectedDrive, folder.id)
    },
    [selectedSite, selectedDrive, loadFolderContents]
  )

  const toggleFile = useCallback((fileId: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(fileId)) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }, [])

  const handleImport = useCallback(async () => {
    if (selectedFiles.size === 0) return
    const items = step === "search" ? searchResults : files
    setError(null)
    setIsImporting(true)
    try {
      const refs: SharePointFileRef[] = items
        .filter((f) => selectedFiles.has(f.id) && !f.isFolder)
        .flatMap((f) => {
          const driveId = f.driveId ?? selectedDrive?.id
          if (!driveId) return []
          return [{ siteId: selectedSite?.id, driveId, itemId: f.id, name: f.name }]
        })

      if (refs.length === 0) {
        setError("Could not resolve the drive for the selected files.")
        return
      }

      const result = await importDocuments(refs)

      if (result.errors.length > 0) {
        setError(
          `Imported ${result.imported.length} file(s). Errors: ${result.errors.map((e) => e.file).join(", ")}`
        )
        setSelectedFiles(new Set())
        refreshDocuments()
        return
      }

      setSelectedFiles(new Set())
      refreshDocuments()
      setView("chat")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setIsImporting(false)
    }
  }, [selectedFiles, step, searchResults, files, selectedSite, selectedDrive, refreshDocuments, setView])

  const goBack = useCallback(() => {
    setError(null)
    if (step === "files") {
      if (folderStack.length > 0 && selectedSite && selectedDrive) {
        const next = folderStack.slice(0, -1)
        setFolderStack(next)
        const parentId = next.length ? next[next.length - 1].id : undefined
        void loadFolderContents(selectedSite, selectedDrive, parentId)
      } else {
        setStep("drives")
      }
    } else if (step === "drives") {
      setStep("sites")
    } else if (step === "sites") {
      setSelectedFiles(new Set())
      setStep("search")
    }
  }, [step, folderStack, selectedSite, selectedDrive, loadFolderContents])

  useEffect(() => {
    runSearch("", 0)
  }, [runSearch])

  const browseBreadcrumb = (() => {
    if (step === "drives") return selectedSite?.displayName ?? ""
    if (step === "files") {
      const parts = [selectedSite?.displayName, selectedDrive?.name, ...folderStack.map((c) => c.name)]
      return parts.filter(Boolean).join(" / ")
    }
    return "Select a site"
  })()

  const fileRow = (item: SharePointFile) => {
    const isSelected = selectedFiles.has(item.id)
    return (
      <button
        key={item.id}
        onClick={() => toggleFile(item.id)}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-muted",
          isSelected && "bg-primary/10"
        )}
      >
        <div
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded border",
            isSelected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-muted-foreground/30"
          )}
        >
          {isSelected && <Check className="size-3" />}
        </div>
        <FileText className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{item.name}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {formatFileSize(item.size)}
        </span>
      </button>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-6 py-4">
        <Cloud className="size-5 text-primary" />
        <h2 className="text-base font-semibold">Browse SharePoint</h2>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto gap-1.5"
          onClick={() => setShowAddLinks(true)}
        >
          <LinkSimple className="size-4" />
          Add by links
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => setView("chat")}
        >
          <X className="size-4" />
          Back to chat
        </Button>
      </div>

      {showAddLinks && (
        <AddByLinksDialog
          onClose={() => setShowAddLinks(false)}
          onImported={refreshDocuments}
        />
      )}

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-3 overflow-hidden px-6 py-6">
        {step === "search" ? (
          <div className="flex items-center gap-2">
            <form
              className="relative flex-1"
              onSubmit={(e) => {
                e.preventDefault()
                runSearch(queryInput, 0)
              }}
            >
              <MagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
                placeholder="Search all your SharePoint & OneDrive files"
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </form>
            <Button variant="outline" size="sm" onClick={loadSites}>
              <FolderOpen data-icon="inline-start" />
              Browse by site
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs" onClick={goBack}>
              <CaretLeft />
            </Button>
            <span className="truncate text-sm text-muted-foreground">{browseBreadcrumb}</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1.5"
              onClick={() => {
                setSelectedFiles(new Set())
                setStep("search")
              }}
            >
              <MagnifyingGlass className="size-3.5" />
              Search all files
            </Button>
          </div>
        )}

        {isLoading && (step !== "search" || searchFrom === 0) ? (
          <div className="flex flex-1 items-center justify-center">
            <CircleNotch className="size-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1">
              {step === "search" && (
                <>
                  {searchResults.map((item) => fileRow(item))}
                  {searchResults.length === 0 && (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      {searchTerm ? "No files match your search" : "No files found"}
                    </p>
                  )}
                  {moreAvailable && (
                    <Button
                      variant="ghost"
                      className="mt-1 w-full"
                      onClick={() => runSearch(searchTerm, searchFrom + PAGE_SIZE)}
                      disabled={isLoading}
                    >
                      {isLoading && <CircleNotch className="size-4 animate-spin" data-icon="inline-start" />}
                      Load more
                    </Button>
                  )}
                </>
              )}

              {step === "sites" &&
                sites.map((site) => (
                  <button
                    key={site.id}
                    onClick={() => loadDrives(site)}
                    className="flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-muted"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{site.displayName}</span>
                  </button>
                ))}

              {step === "drives" &&
                drives.map((drive) => (
                  <button
                    key={drive.id}
                    onClick={() => openDrive(drive)}
                    className="flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-muted"
                  >
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{drive.name}</span>
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {drive.driveType}
                    </Badge>
                  </button>
                ))}

              {step === "files" &&
                files.map((item) => {
                  if (item.isFolder) {
                    return (
                      <button
                        key={item.id}
                        onClick={() => openFolder(item)}
                        className="flex items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm hover:bg-muted"
                      >
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{item.name}</span>
                        {typeof item.childCount === "number" && (
                          <span className="text-xs text-muted-foreground">{item.childCount}</span>
                        )}
                        <CaretRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                      </button>
                    )
                  }
                  return fileRow(item)
                })}

              {((step === "sites" && sites.length === 0) ||
                (step === "drives" && drives.length === 0) ||
                (step === "files" && files.length === 0)) && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  This folder is empty
                </p>
              )}
            </div>
          </ScrollArea>
        )}

        {selectedFiles.size > 0 && (
          <Button className="w-full" onClick={handleImport} disabled={isImporting}>
            {isImporting ? (
              <CircleNotch className="size-4 animate-spin" data-icon="inline-start" />
            ) : (
              <Cloud data-icon="inline-start" />
            )}
            Import {selectedFiles.size} file{selectedFiles.size !== 1 ? "s" : ""}
          </Button>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  )
}

// Matches MAX_LINKS_PER_REQUEST on the backend.
const MAX_LINKS = 20

function AddByLinksDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [text, setText] = useState("")
  const [importing, setImporting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    imported: { id: string; filename: string; chunkCount: number; message: string }[]
    errors: { file: string; error: string }[]
  } | null>(null)

  const links = [...new Set(text.split("\n").map((l) => l.trim()).filter(Boolean))]
  const tooMany = links.length > MAX_LINKS

  const runImport = async () => {
    setImporting(true)
    setFormError(null)
    setResult(null)
    try {
      const res = await importDocumentLinks(links)
      setResult(res)
      if (res.imported.length > 0) onImported()
      // Keep only the failed links in the box so they can be fixed and retried.
      setText(res.errors.map((e) => e.file).join("\n"))
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add documents by link</DialogTitle>
          <DialogDescription>
            Paste SharePoint file links, one per line. Files are imported with
            your access, become readable by everyone, and are refreshed on
            every sync.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            placeholder={"https://contoso.sharepoint.com/sites/QA/Shared Documents/manual.pdf\nhttps://…"}
          />

          {tooMany && (
            <p className="text-sm text-destructive">
              At most {MAX_LINKS} links at a time.
            </p>
          )}

          {result && (
            <div className="max-h-40 space-y-1 overflow-y-auto text-sm">
              {result.imported.map((r) => (
                <p key={r.id} className="flex items-start gap-2 text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0 truncate">
                    {r.filename} — {r.message}
                  </span>
                </p>
              ))}
              {result.errors.map((e) => (
                <p key={e.file} className="flex items-start gap-2 text-destructive">
                  <WarningCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 break-all">
                    {e.file}: {e.error}
                  </span>
                </p>
              ))}
            </div>
          )}

          {formError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <WarningCircle className="mt-0.5 size-4 shrink-0" />
              {formError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            {result ? "Close" : "Cancel"}
          </Button>
          <Button disabled={importing || links.length === 0 || tooMany} onClick={runImport}>
            {importing && <CircleNotch className="animate-spin" data-icon="inline-start" />}
            Import{links.length > 0 ? ` ${links.length} link${links.length !== 1 ? "s" : ""}` : " links"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Folders first, then files; each group alphabetical.
function sortItems(items: SharePointFile[]): SharePointFile[] {
  return [...items].sort((a, b) => {
    if (Boolean(a.isFolder) !== Boolean(b.isFolder)) return a.isFolder ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
