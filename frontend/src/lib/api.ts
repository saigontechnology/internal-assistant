export interface DocumentInfo {
  id: string
  filename: string
  fileType: string
  chunkCount: number
  source: "sharepoint" | "upload"
  sharepointUrl?: string
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
