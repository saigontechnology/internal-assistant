export type SyncStatus = "synced" | "pending_access" | "failed_parse" | "failed_resolve"

export interface DocumentInfo {
  id: string
  filename: string
  fileType: string
  chunkCount: number
  source: "sharepoint" | "upload" | "sharepoint-list"
  sharepointUrl?: string
  /** "Open in browser" URL — DocIdRedir for list rows, webUrl for imports. */
  linkUrl?: string
  sharepointCode?: string
  sharepointVersion?: string
  /** Newer Ver detected on the list but no caller could resolve the new file yet. */
  sharepointPendingVersion?: string
  syncStatus?: SyncStatus
  syncError?: string
  title?: string
  distribution?: string
}

export interface SyncCounters {
  seen: number
  ingested: number
  updated: number
  skipped: number
  pending: number
  removed: number
  failed: number
}

export interface SyncRunTotals extends SyncCounters {
  registryRows: number
  distributionListsResolved: number
  distributionListsUnresolved: number
  distributionListsOrphaned: number
}

export interface PerListSummary {
  distributionListId: string
  displayName: string
  targetListId: string | null
  status: "ok" | "partial" | "error" | "unresolvable"
  counters: SyncCounters
  itemErrors: { code?: string; rowId?: string; error: string }[]
  fatalError?: string
}

export interface SyncRun {
  triggeredBy: "manual" | "cron"
  startedAt: string
  finishedAt: string
  durationMs: number
  status: "ok" | "partial" | "error"
  totals: SyncRunTotals
  lists: PerListSummary[]
  fatalError?: string
}

export interface WatcherStateRow {
  listId: string
  lastRunAt: string | null
  lastStatus: string
  lastError: string | null
  itemsSeen: number
  itemsIngested: number
  itemsUpdated: number
  itemsSkipped: number
  itemsPending: number
  itemsRemoved: number
  itemsFailed: number
}

export interface SyncStatusResponse {
  running: boolean
  currentStartedAt: string | null
  lastRun: SyncRun | null
  persistedState: WatcherStateRow[]
  indexState: Record<SyncStatus, number>
}

// ─── Distribution lists (registry-driven) ─────────────────────────────

export interface DistributionListSummary {
  id: string
  displayName: string
  note: string | null
  listUrl: string
  lastSyncedAt: string | null
  lastSyncStatus: string
  lastSyncError: string | null
  counters: {
    synced: number
    pending: number
    failed: number
    removed: number
  }
}

export interface DistributionListDetail extends DistributionListSummary {
  registryListId: string
  registryItemId: string
  siteId: string | null
  targetListId: string | null
  itemsSynced: number
  itemsPending: number
  itemsFailed: number
  itemsRemoved: number
  createdAt: string
  updatedAt: string
}

export interface DistributionListItem {
  id: string
  distributionListId: string
  resourceId: string | null
  sharepointCode: string
  sharepointTitle: string
  sharepointVersion: string
  lastSeenAt: string
  syncStatus: SyncStatus | string
  syncError: string | null
}

export async function fetchDistributionLists(): Promise<DistributionListSummary[]> {
  const res = await apiFetch("/api/distribution-lists")
  const data = await res.json()
  return data.lists
}

export async function fetchDistributionListItems(
  id: string,
  opts: { cursor?: string; take?: number } = {},
): Promise<{ items: DistributionListItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (opts.cursor) params.set("cursor", opts.cursor)
  if (opts.take) params.set("take", String(opts.take))
  const qs = params.toString()
  const res = await apiFetch(`/api/distribution-lists/${id}/items${qs ? `?${qs}` : ""}`)
  return res.json()
}

export interface SharePointSite {
  id: string
  displayName: string
  webUrl: string
}

export interface SharePointDrive {
  id: string
  name: string
  driveType: string
}

export interface SharePointFile {
  id: string
  name: string
  size: number
  webUrl: string
  lastModifiedDateTime: string
  mimeType?: string
  isFolder?: boolean
  childCount?: number
  driveId?: string
}

export interface SharePointFileRef {
  siteId?: string
  driveId: string
  itemId: string
  name: string
}

// The session cookie is sent automatically (same-origin via the Vite proxy),
// so no Authorization header is needed.
async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, options)

  if (!res.ok) {
    if (res.status === 401) throw new Error("Not signed in")
    const error = await res.json().catch(() => ({ error: "Request failed" }))
    throw new Error(error.error || error.detail || "Request failed")
  }

  return res
}

export async function fetchDocuments(): Promise<DocumentInfo[]> {
  const res = await fetch("/api/documents")

  if (!res.ok) {
    throw new Error("Failed to fetch documents")
  }

  const data = await res.json()
  return data.documents
}

export async function deleteDocument(docId: string): Promise<void> {
  const res = await fetch(`/api/documents/${docId}`, {
    method: "DELETE",
  })

  if (!res.ok) {
    throw new Error("Failed to delete document")
  }
}

export async function uploadFile(
  file: File
): Promise<{ id: string; filename: string; chunkCount: number; message: string }> {
  const formData = new FormData()
  formData.append("file", file)

  const res = await fetch("/api/documents/upload", {
    method: "POST",
    body: formData,
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Upload failed" }))
    throw new Error(error.error || "Upload failed")
  }

  return res.json()
}

export async function importDocuments(
  files: SharePointFileRef[]
): Promise<{
  imported: { id: string; filename: string; chunkCount: number; message: string }[]
  errors: { file: string; error: string }[]
}> {
  const res = await apiFetch("/api/documents/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  })

  return res.json()
}

export async function fetchSharePointSites(): Promise<SharePointSite[]> {
  const res = await apiFetch("/api/sharepoint/sites")
  const data = await res.json()
  return data.sites
}

export async function fetchSharePointDrives(
  siteId: string
): Promise<SharePointDrive[]> {
  const res = await apiFetch(
    `/api/sharepoint/drives?siteId=${encodeURIComponent(siteId)}`
  )
  const data = await res.json()
  return data.drives
}

export async function fetchSharePointFiles(
  siteId: string,
  driveId: string,
  folderId?: string
): Promise<SharePointFile[]> {
  const params = new URLSearchParams({ siteId, driveId })
  if (folderId) params.set("folderId", folderId)

  const res = await apiFetch(`/api/sharepoint/files?${params}`)
  const data = await res.json()
  return data.files
}

export async function fetchSharePointSearch(
  query: string,
  from = 0
): Promise<{ files: SharePointFile[]; moreAvailable: boolean }> {
  const params = new URLSearchParams({ q: query, from: String(from) })
  const res = await apiFetch(`/api/sharepoint/search?${params}`)
  const data = await res.json()
  return { files: data.files ?? [], moreAvailable: Boolean(data.moreAvailable) }
}

export async function fetchSyncStatus(): Promise<SyncStatusResponse> {
  const res = await apiFetch("/api/sync/status")
  return res.json()
}

/**
 * Trigger a sync. Resolves with the final SyncRun summary; the request stays
 * open for the entire sync duration (~10 min on the full list). Callers should
 * give it a generous AbortSignal or just rely on the in-process lock.
 */
// ─── User profile (job-title-based access) ────────────────────────────

export interface UserMe {
  email: string
  jobTitle: string
  department: string
  /** True iff the user's own job profile has been scanned at least once. */
  profileIndexed: boolean
  /** True when chat falls back to public-only (no allow-list applies yet). */
  publicOnly: boolean
  lastSync: string | null
}

export async function fetchUserMe(): Promise<UserMe> {
  const res = await apiFetch("/api/user/me")
  return res.json()
}

export async function triggerSync(signal?: AbortSignal): Promise<SyncRun> {
  const res = await fetch("/api/sync", { method: "POST", signal })
  if (res.status === 409) throw new Error("A sync is already running")
  if (res.status === 412) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || "SharePoint access unavailable — sign out and back in")
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Sync failed (HTTP ${res.status})`)
  }
  return res.json()
}
