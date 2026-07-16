import { apiFetch, type SyncRun, type PerListSummary } from "@/lib/api"

// ── Users ────────────────────────────────────────────────────────────

export interface AdminUser {
  email: string
  role: "admin" | "user"
  isActive: boolean
  /** Original AAD casing, or the admin's raw input when overridden. */
  jobTitle: string
  department: string
  /** The lowercased join keys actually used for access filtering. */
  normalizedJobTitle: string
  normalizedDepartment: string
  profileOverride: boolean
  isAllowedToSync: boolean
  lastSync: string | null
  lastError: string | null
  createdAt: string
}

export interface UpdateUserPatch {
  role?: "admin" | "user"
  isActive?: boolean
  isAllowedToSync?: boolean
  /** jobTitle and department must be sent together — they're one tuple. */
  jobTitle?: string
  department?: string
  clearProfileOverride?: boolean
}

const json = { "Content-Type": "application/json" }

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await apiFetch("/api/admin/users")
  return (await res.json()).users
}

/** Returns the full refreshed list, so the caller doesn't need a second GET. */
export async function updateAdminUser(
  email: string,
  patch: UpdateUserPatch,
): Promise<AdminUser[]> {
  const res = await apiFetch(`/api/admin/users/${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify(patch),
  })
  return (await res.json()).users
}

export async function resyncAdminUser(email: string): Promise<{ message: string }> {
  const res = await apiFetch(`/api/admin/users/${encodeURIComponent(email)}/resync`, {
    method: "POST",
  })
  return res.json()
}

// ── Documents ────────────────────────────────────────────────────────

export interface AdminDocument {
  id: string
  filename: string
  fileType: string
  source: string
  sharepointUrl: string | null
  sharepointCode: string | null
  sharepointVersion: string | null
  sharepointPendingVersion: string | null
  syncStatus: string
  syncError: string | null
  fileDate: string | null
  lastSyncAttempt: string | null
  chunkCount: number
  lists: { id: string; displayName: string }[]
  updatedAt: string
}

export async function fetchAdminDocuments(opts: {
  q?: string
  status?: string
  cursor?: string
} = {}): Promise<{ documents: AdminDocument[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (opts.q) params.set("q", opts.q)
  if (opts.status) params.set("status", opts.status)
  if (opts.cursor) params.set("cursor", opts.cursor)
  const qs = params.toString()
  const res = await apiFetch(`/api/admin/documents${qs ? `?${qs}` : ""}`)
  return res.json()
}

export async function deleteAdminDocument(id: string): Promise<void> {
  await apiFetch(`/api/admin/documents/${id}`, { method: "DELETE" })
}

export async function resyncAdminDocument(id: string): Promise<{ message: string }> {
  const res = await apiFetch(`/api/admin/documents/${id}/resync`, { method: "POST" })
  return res.json()
}

export async function runFullSync(): Promise<SyncRun> {
  const res = await apiFetch("/api/admin/documents/sync", { method: "POST" })
  return res.json()
}

// ── Distribution lists (document links) ──────────────────────────────

export interface AdminList {
  id: string
  displayName: string
  note: string | null
  listUrl: string
  enabled: boolean
  siteId: string | null
  targetListId: string | null
  createdByEmail: string | null
  lastSyncedAt: string | null
  lastSyncStatus: string
  lastSyncError: string | null
  counters: { synced: number; pending: number; failed: number; removed: number }
}

export interface ListInput {
  displayName: string
  note?: string | null
  listUrl: string
}

export async function fetchAdminLists(): Promise<AdminList[]> {
  const res = await apiFetch("/api/admin/distribution-lists")
  return (await res.json()).lists
}

export async function createAdminList(input: ListInput): Promise<AdminList> {
  const res = await apiFetch("/api/admin/distribution-lists", {
    method: "POST",
    headers: json,
    body: JSON.stringify(input),
  })
  return (await res.json()).list
}

export async function updateAdminList(
  id: string,
  patch: Partial<ListInput> & { enabled?: boolean },
): Promise<AdminList> {
  const res = await apiFetch(`/api/admin/distribution-lists/${id}`, {
    method: "PATCH",
    headers: json,
    body: JSON.stringify(patch),
  })
  return (await res.json()).list
}

export async function deleteAdminList(id: string): Promise<{ message: string }> {
  const res = await apiFetch(`/api/admin/distribution-lists/${id}`, { method: "DELETE" })
  return res.json()
}

export async function syncAdminList(id: string): Promise<PerListSummary> {
  const res = await apiFetch(`/api/admin/distribution-lists/${id}/sync`, { method: "POST" })
  return res.json()
}

export interface RegistryImportResult {
  rowsSeen: number
  created: number
  updated: number
  unresolved: number
}

/** One-shot migration off the legacy SharePoint registry list. Idempotent. */
export async function importRegistry(): Promise<RegistryImportResult> {
  const res = await apiFetch("/api/admin/distribution-lists/import-registry", {
    method: "POST",
  })
  return res.json()
}

// ── Chat model (OpenCode ladder) ─────────────────────────────────────

export type LadderRung = "primary" | "fallback" | "secondFallback"

/** Display order and copy for the three fallback rungs. */
export const LADDER_RUNGS: { rung: LadderRung; label: string; hint: string }[] = [
  { rung: "primary", label: "Primary", hint: "Tried first for every chat request." },
  { rung: "fallback", label: "First fallback", hint: "Used while the primary is cooling down after a 429." },
  { rung: "secondFallback", label: "Second fallback", hint: "Last resort before chat surfaces an error." },
]

export interface OpencodeModel {
  id: string
  ownedBy: string | null
}

export interface SettingDetail {
  value: string
  /** 'db' = pinned by an admin, 'env' = falling back to the env var. */
  source: "db" | "env"
  envDefault: string
  updatedByEmail: string | null
  updatedAt: string | null
}

export interface LadderRungDetail extends SettingDetail {
  rung: LadderRung
  /** null when the catalog couldn't be fetched, so membership is unknown. */
  inCatalog: boolean | null
  /** The prefixed id actually sent to the gateway, e.g. "opencode-go/glm-5.2". */
  resolved: string
}

export interface ChatModelSettings {
  provider: "openai" | "gemini" | "opencode"
  /** False when CHAT_PROVIDER != opencode — the ladder is stored but unused. */
  active: boolean
  models: OpencodeModel[]
  catalogError: string | null
  /** Call-time namespace prepended to every rung. Empty = send bare ids. */
  prefix: SettingDetail
  ladder: LadderRungDetail[]
}

export interface ChatModelInput {
  primary: string
  fallback: string
  secondFallback: string
  prefix: string
}

interface ChatModelConfig {
  ladder: LadderRungDetail[]
  prefix: SettingDetail
}

export async function fetchChatModelSettings(refresh = false): Promise<ChatModelSettings> {
  const res = await apiFetch(`/api/admin/chat-model${refresh ? "?refresh=true" : ""}`)
  return res.json()
}

export async function updateChatModelConfig(input: ChatModelInput): Promise<ChatModelConfig> {
  const res = await apiFetch("/api/admin/chat-model", {
    method: "PUT",
    headers: json,
    body: JSON.stringify(input),
  })
  return res.json()
}

export async function resetChatModelConfig(): Promise<ChatModelConfig> {
  const res = await apiFetch("/api/admin/chat-model/reset", { method: "POST" })
  return res.json()
}

/** Mirrors the backend's applyPrefix — used for the live preview in the form. */
export function applyPrefix(prefix: string, modelId: string): string {
  const p = prefix.trim().replace(/^\/+|\/+$/g, "")
  return p ? `${p}/${modelId}` : modelId
}

// ── Runtime settings ─────────────────────────────────────────────────

export type SettingGroup =
  | "chat"
  | "retrieval"
  | "limits"
  | "ingest"
  | "sharepoint"
  | "users"

export interface SettingGroupInfo {
  group: SettingGroup
  title: string
  blurb: string
}

export interface RuntimeSetting {
  key: string
  group: SettingGroup
  label: string
  help: string
  kind: "string" | "number"
  /** The env var this falls back to when no override is stored. */
  envVar: string
  min: number | null
  max: number | null
  /**
   * Set on settings whose blast radius exceeds the field — changing the
   * embedding model invalidates every stored vector, lowering the persisted
   * history cap deletes messages. Rendered as a warning beside the input.
   */
  danger: string | null
  value: string
  source: "db" | "env"
  envDefault: string
  updatedByEmail: string | null
  updatedAt: string | null
}

export interface EnvEntry {
  name: string
  secret: boolean
  note: string | null
  /** Masked for secrets, null when unset. Never the raw secret. */
  value: string | null
  isSet: boolean
}

export interface AdminSettings {
  groups: SettingGroupInfo[]
  settings: RuntimeSetting[]
  environment: EnvEntry[]
}

export async function fetchAdminSettings(): Promise<AdminSettings> {
  const res = await apiFetch("/api/admin/settings")
  return res.json()
}

/** Sparse update — only the keys present are written. Returns the fresh state. */
export async function updateAdminSettings(
  values: Record<string, string>,
): Promise<AdminSettings> {
  const res = await apiFetch("/api/admin/settings", {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ values }),
  })
  return res.json()
}

/** Omit `keys` to reset every editable setting to its env default. */
export async function resetAdminSettings(keys?: string[]): Promise<AdminSettings> {
  const res = await apiFetch("/api/admin/settings/reset", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ keys: keys ?? [] }),
  })
  return res.json()
}
