import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { GraphTokenProvider } from './graph-token-provider.js'

/**
 * Talks to the Microsoft Graph endpoints the watcher needs:
 *   - resolve the configured SITE_PATH to a siteId (cached in-process)
 *   - find the registry list ("Document Distribution List") and read its rows
 *   - dereference each registry row's Link to a (siteId, listId) target
 *   - paginate target-list items with $expand=fields
 *   - resolve a list row to a driveItem via Strategy H
 *   - download driveItem content
 *
 * Cross-site links are followed: registry rows can point to lists outside
 * SHAREPOINT_SITE_PATH (the registry IS the trust boundary).
 *
 * See docs/multi-list-watcher-plan.md.
 */

export interface ListRow {
  /** Graph list-item id (number-as-string). */
  id: string
  /** All fields, including the SP-defined columns: Title, Code, Ver, Date, Link, Distribution. */
  fields: Record<string, unknown>
}

export interface ResolvedDriveItem {
  driveId: string
  itemId: string
  name: string
  eTag?: string
  size?: number
  webUrl?: string
}

/** One row in the registry list. */
export interface RegistryRow {
  /** Graph list-item id within the registry list. */
  registryItemId: string
  /** "List Name" — from the registry row's Title column. */
  displayName: string
  /** Raw URL from the row's Link hyperlink column. */
  listUrl: string
  /** Optional Note column text. */
  note: string | null
}

export interface RegistryResolveResult {
  /** Graph listId of the registry list itself. */
  registryListId: string
  rows: RegistryRow[]
}

/** Successful dereference of a registry row's Link URL. */
export interface ResolvedTargetList {
  siteId: string
  listId: string
  /** Hostname extracted from the URL, for diagnostics. */
  hostname: string
  /** SharePoint list displayName as it lives on the target site. */
  displayName: string
}

interface GraphList {
  id: string
  displayName: string
  webUrl?: string
  list?: {
    template?: string
    hidden?: boolean
  }
}

export class SharepointListService {
  /** siteId for the configured SITE_PATH (the registry's home site). */
  private siteCache: { siteId: string } | null = null
  /** Memoized siteId per hostname:path so cross-site lookups don't repeat. */
  private readonly siteByPath = new Map<string, string>()
  /** Memoized listId per (siteId, displayName) so we don't paginate lists twice. */
  private readonly listByName = new Map<string, string>()

  constructor(private readonly config: RuntimeSettingsService) {}

  /** Reset every cache. */
  resetCache(): void {
    this.siteCache = null
    this.siteByPath.clear()
    this.listByName.clear()
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Resolve and cache the siteId for the configured site path. */
  async resolveSite(tokens: GraphTokenProvider): Promise<{ siteId: string }> {
    if (this.siteCache) return this.siteCache
    const cfg = this.config
    console.log(`[sharepoint-list] resolving siteId for ${cfg.sharepointHostname}:${cfg.sharepointSitePath}...`,)
    const siteId = await this.lookupSite(tokens, cfg.sharepointHostname, cfg.sharepointSitePath)
    this.siteCache = { siteId }
    return this.siteCache
  }

  /**
   * Find the registry list under SITE_PATH and read every row. The registry
   * name is matched case-insensitively against `displayName`.
   *
   * Throws when the registry list isn't found (a fatal config error — we
   * can't do anything useful without it).
   */
  async resolveRegistry(tokens: GraphTokenProvider): Promise<RegistryResolveResult> {
    const { siteId } = await this.resolveSite(tokens)
    const wantedName = this.config.sharepointRegistryListName.toLowerCase()

    const all = await this.fetchAllLists(tokens, siteId)
    console.log(`[sharepoint-list] discovered lists at site ${siteId}:`, all.map((l) => l.displayName))
    const registry = all.find((l) => l.displayName.toLowerCase() === wantedName)
    console.log('[sharepoint-list] found registry list:', registry)
    if (!registry) {
      throw new Error(
        `Registry list "${this.config.sharepointRegistryListName}" not found at site ` +
          `${this.config.sharepointSitePath}. Discovered: ${all.map((l) => l.displayName).join(', ')}`,
      )
    }

    const rows: RegistryRow[] = []
    let rowsSeen = 0
    for await (const row of this.iterateItems(tokens, registry.id)) {
      rowsSeen++
      const parsed = parseRegistryRow(row)
      if (parsed) {
        rows.push(parsed)
      } else {
        // The most common reason this branch fires: the registry row's
        // columns have internal names we didn't guess. Log the raw field
        // keys + sample values so we can broaden parseRegistryRow.
        const f = (row.fields ?? {}) as Record<string, unknown>
        console.warn('[sharepoint-list] registry row parse miss', {
          rowId: row.id,
          fieldKeys: Object.keys(f),
          sample: Object.fromEntries(
            Object.entries(f).slice(0, 20).map(([k, v]) => [
              k,
              typeof v === 'string' ? v.slice(0, 120) : v,
            ]),
          ),
        })
      }
    }
    console.log(
      `[sharepoint-list] registry "${registry.displayName}" → seen=${rowsSeen} parsed=${rows.length}`,
    )
    return { registryListId: registry.id, rows }
  }

  /**
   * Dereference a registry row's Link URL to a (siteId, listId) target.
   * Returns null when the URL is malformed, the site can't be reached, or
   * the list isn't visible to the caller. The caller turns that null into
   * `last_sync_status='unresolvable'` on the distribution_lists row.
   */
  async resolveTargetList(
    tokens: GraphTokenProvider,
    listUrl: string,
  ): Promise<ResolvedTargetList | null> {
    const parsed = parseSharepointListUrl(listUrl)
    if (!parsed) return null
    const { hostname, sitePath, listName } = parsed

    try {
      const siteId = await this.lookupSite(tokens, hostname, sitePath)
      const listId = await this.lookupListByName(tokens, siteId, listName)
      if (!listId) return null
      return { siteId, listId, hostname, displayName: listName }
    } catch (err) {
      console.warn(
        `[sharepoint-list] resolveTargetList failed for "${listUrl}":`,
        (err as Error).message?.slice(0, 200),
      )
      return null
    }
  }

  /**
   * Iterate every row in the given list. Yields rows in pages of 200.
   * When `modifiedSince` is provided, adds `$filter=lastModifiedDateTime ge ...`
   * for the incremental sync path.
   */
  async *iterateItems(
    tokens: GraphTokenProvider,
    listId: string,
    opts: { modifiedSince?: Date } = {},
  ): AsyncGenerator<ListRow, void, void> {
    const { siteId } = await this.resolveSite(tokens)
    type Page = { value: ListRow[]; '@odata.nextLink'?: string }

    const query = new URLSearchParams()
    query.set('$expand', 'fields')
    query.set('$top', '200')
    if (opts.modifiedSince) {
      query.set('$filter', `lastModifiedDateTime ge ${opts.modifiedSince.toISOString()}`)
    }
    let next: string | null = `/sites/${siteId}/lists/${listId}/items?${query.toString()}`
    while (next) {
      const page: Page = await this.graphGet<Page>(tokens, next)
      for (const row of page.value ?? []) yield row
      next = page['@odata.nextLink']
        ? page['@odata.nextLink'].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')
        : null
    }
  }

  /**
   * Variant of iterateItems that uses an explicit (siteId, listId) pair —
   * needed for cross-site target lists discovered via the registry.
   */
  async *iterateItemsAt(
    tokens: GraphTokenProvider,
    siteId: string,
    listId: string,
    opts: { modifiedSince?: Date } = {},
  ): AsyncGenerator<ListRow, void, void> {
    type Page = { value: ListRow[]; '@odata.nextLink'?: string }
    const query = new URLSearchParams()
    query.set('$expand', 'fields')
    query.set('$top', '200')
    if (opts.modifiedSince) {
      query.set('$filter', `lastModifiedDateTime ge ${opts.modifiedSince.toISOString()}`)
    }
    let next: string | null = `/sites/${siteId}/lists/${listId}/items?${query.toString()}`
    while (next) {
      const page: Page = await this.graphGet<Page>(tokens, next)
      for (const row of page.value ?? []) yield row
      next = page['@odata.nextLink']
        ? page['@odata.nextLink'].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')
        : null
    }
  }

  /**
   * Strategy H from docs/sharepoint-list-watcher-plan.md §3a — search for the
   * predicted filename `<Code> - <Title> - v<Ver>` and pick the top hit whose
   * actual name matches the stem prefix.
   *
   * Graph `/search/query` for `driveItem` is tenant-scoped (not list-scoped),
   * so this works the same regardless of which target list the row came from.
   */
  async resolveByCode(
    tokens: GraphTokenProvider,
    args: { code: string; title: string; version: string },
  ): Promise<ResolvedDriveItem | null> {
    const stem = buildPredictedStem(args)
    const normStem = normalizeForMatch(stem)
    const normCode = normalizeForMatch(args.code)
    const codeRegex = buildCodeTokenRegex(args.code)
    const versionRegex = buildVersionRegex(args.version)
    const bumpedVersion = bumpVersion(args.version)
    const bumpedVersionRegex = bumpedVersion ? buildVersionRegex(bumpedVersion) : null

    const isPlaceholderCode = /^\s*n\s*\/?\s*a\b/i.test(args.code)
    const titleTokens = buildTitleTokens(args.title)
    const parensHint = (args.code.match(/\(([^)]+)\)/)?.[1] ?? '').trim().toLowerCase()

    const pickBest = (hits: SearchHit[]): SearchHit | undefined => {
      const named = hits.filter((h) => h.resource?.name)
      const norm = (h: SearchHit) => normalizeForMatch(h.resource!.name!)

      if (!isPlaceholderCode) {
        const codeMatches = named.filter(
          (h) => codeRegex.test(norm(h)) || norm(h).includes(normCode),
        )
        const codeHit =
          named.find((h) => norm(h).startsWith(normStem)) ??
          (versionRegex ? codeMatches.find((h) => versionRegex.test(norm(h))) : undefined) ??
          (bumpedVersionRegex ? codeMatches.find((h) => bumpedVersionRegex.test(norm(h))) : undefined) ??
          codeMatches[0]
        if (codeHit) return codeHit
      }

      if (titleTokens.length >= 3) {
        let best: { hit: SearchHit | undefined; score: number } = { hit: undefined, score: 0 }
        for (const h of named) {
          let score = titleOverlapScore(norm(h), titleTokens)
          if (parensHint && norm(h).includes(parensHint)) score += 0.3
          if (score > best.score) best = { hit: h, score }
        }
        if (best.score >= 0.7) return best.hit
      }

      return undefined
    }

    let items: SearchHit[] = []
    let matched: SearchHit | undefined
    if (!isPlaceholderCode) {
      items = await this.searchDriveItems(tokens, `"${stem}"`, 5)
      matched = pickBest(items)
    }

    if (!matched?.resource && !isPlaceholderCode) {
      const fallback = await this.searchDriveItems(tokens, args.code, 25)
      matched = pickBest(fallback)
      if (matched) items = fallback
    }

    const titleWords = args.title.trim().split(/\s+/)
    if (!matched?.resource && titleWords.length >= 3) {
      const titleHits = await this.searchDriveItems(tokens, `"${args.title.trim()}"`, 25)
      matched = pickBest(titleHits)
      if (matched) items = titleHits
    }

    if (!matched?.resource && titleWords.length > 4) {
      const firstFour = titleWords.slice(0, 4).join(' ')
      const partialHits = await this.searchDriveItems(tokens, `"${firstFour}"`, 25)
      matched = pickBest(partialHits)
      if (matched) items = partialHits
    }

    if (!matched?.resource && parensHint) {
      const hintHits = await this.searchDriveItems(tokens, parensHint, 25)
      matched = pickBest(hintHits)
      if (matched) items = hintHits
    }

    if (!matched?.resource) {
      console.warn('[Strategy H miss]', {
        code: args.code,
        title: args.title,
        version: args.version,
        stem,
        normStem,
        hits: items.map((h) => h.resource?.name).filter(Boolean),
      })
      return null
    }
    const r = matched.resource
    const driveId = r.parentReference?.driveId
    if (!driveId || !r.id || !r.name) return null
    return { driveId, itemId: r.id, name: r.name, eTag: r.eTag, size: r.size, webUrl: r.webUrl }
  }

  private async searchDriveItems(
    tokens: GraphTokenProvider,
    queryString: string,
    size: number,
  ): Promise<SearchHit[]> {
    const res = await this.graphPost<SearchResponse>(tokens, '/search/query', {
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString },
          fields: ['id', 'name', 'parentReference', 'eTag', 'size', 'webUrl'],
          from: 0,
          size,
        },
      ],
    })
    return res.value?.[0]?.hitsContainers?.[0]?.hits ?? []
  }

  /** Stream the file bytes for a resolved driveItem into a Buffer. */
  async downloadFile(tokens: GraphTokenProvider, item: ResolvedDriveItem): Promise<Buffer> {
    const url = `https://graph.microsoft.com/v1.0/drives/${item.driveId}/items/${item.itemId}/content`
    const token = await tokens.getToken()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 300)}`)
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Resolve a (hostname, server-relative-path) pair to a Graph siteId. */
  private async lookupSite(
    tokens: GraphTokenProvider,
    hostname: string,
    sitePath: string,
  ): Promise<string> {
    const key = `${hostname.toLowerCase()}::${sitePath.toLowerCase()}`
    const cached = this.siteByPath.get(key)
    if (cached) return cached
    const path = sitePath.startsWith('/') ? sitePath : `/${sitePath}`
    const site = await this.graphGet<{ id: string }>(tokens, `/sites/${hostname}:${path}`)
    this.siteByPath.set(key, site.id)
    return site.id
  }

  /**
   * Resolve a list to its Graph listId on the given site.
   *
   * `urlName` is the URL-name slug extracted from the registry row's Link
   * (the segment after `/Lists/`). SharePoint lists have two names —
   *   - displayName: current UI label, can have diacritics ("Danh mục total SDC")
   *   - URL-name: the name the list was created with, used in the webUrl
   *     path. SharePoint strips diacritics here ("Danh mc total SDC").
   * The registry's Link column always carries the URL-name, so we match
   * each list's `webUrl` against it. We still fall back to a displayName
   * match in case the list was created with diacritics intact.
   */
  private async lookupListByName(
    tokens: GraphTokenProvider,
    siteId: string,
    urlName: string,
  ): Promise<string | null> {
    const key = `${siteId}::${urlName.toLowerCase()}`
    const cached = this.listByName.get(key)
    if (cached) return cached

    const all = await this.fetchAllLists(tokens, siteId)
    const target = urlName.toLowerCase()

    const byUrl = all.find((l) => {
      if (!l.webUrl) return false
      const seg = extractListSegmentFromWebUrl(l.webUrl)
      return seg !== null && seg.toLowerCase() === target
    })
    if (byUrl) {
      this.listByName.set(key, byUrl.id)
      return byUrl.id
    }

    const byDisplay = all.find((l) => l.displayName.toLowerCase() === target)
    if (byDisplay) {
      this.listByName.set(key, byDisplay.id)
      return byDisplay.id
    }

    console.warn(
      `[sharepoint-list] no list matched URL-name "${urlName}" on site ${siteId}. ` +
        `Considered: ${all.map((l) => `${l.displayName} (webUrl=${l.webUrl ?? 'n/a'})`).join('; ')}`,
    )
    return null
  }

  /** Page through `/sites/{id}/lists`, returning raw list metadata. */
  private async fetchAllLists(tokens: GraphTokenProvider, siteId: string): Promise<GraphList[]> {
    type Page = { value: GraphList[]; '@odata.nextLink'?: string }
    const out: GraphList[] = []
    let next: string | null = `/sites/${siteId}/lists?$select=id,displayName,webUrl,list&$top=200`
    while (next) {
      const page: Page = await this.graphGet<Page>(tokens, next)
      for (const l of page.value ?? []) out.push(l)
      next = page['@odata.nextLink']
        ? page['@odata.nextLink'].replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')
        : null
    }
    return out
  }

  private async graphGet<T>(tokens: GraphTokenProvider, path: string): Promise<T> {
    const token = await tokens.getToken()
    const url = path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }

  private async graphPost<T>(tokens: GraphTokenProvider, path: string, body: unknown): Promise<T> {
    const token = await tokens.getToken()
    const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errBody = await res.text()
      throw new Error(`POST ${path} → ${res.status}: ${errBody.slice(0, 300)}`)
    }
    return (await res.json()) as T
  }
}

// ── Registry-row parsing ─────────────────────────────────────────────

/**
 * Read one registry row (Graph list-item) into our internal RegistryRow shape.
 *
 * Defensive about column casing/aliases:
 *   - List Name comes from `Title` or `List_x0020_Name` or `ListName`.
 *   - Link is a SharePoint hyperlink → `{ Url, Description }` object.
 *   - Note is plain text under `Note`, `Notes`, `Note0`, or `Description`.
 */
function parseRegistryRow(row: ListRow): RegistryRow | null {
  const f = (row.fields ?? {}) as Record<string, unknown>

  // First try known keys; if a hit, great. Otherwise scan all keys for the
  // *shape* we expect — any hyperlink-typed value becomes the listUrl, any
  // long text value not yet claimed becomes the note. Defensive against
  // SharePoint's "we'll pick a weird internal name" tendency on custom
  // columns (e.g. "List_x0020_Name", "Link0", "Notes1").
  const displayName =
    pickString(f, ['Title', 'List_x0020_Name', 'ListName', 'List Name', 'LinkTitle', 'LinkTitleNoMenu']) ||
    scanFirstNonEmptyString(f, ['Link', 'URL', 'Url', 'Note', 'Notes', 'Description', 'id', '_UIVersionString'])

  const listUrl =
    pickHyperlinkUrl(f, ['Link', 'URL', 'Url']) ||
    scanFirstHyperlinkUrl(f, ['Title'])

  const note =
    pickString(f, ['Note', 'Notes', 'Note0', 'Description', 'Note_x0020_', 'Body']) ||
    null

  if (!displayName || !listUrl) return null
  return {
    registryItemId: row.id,
    displayName: displayName.trim(),
    listUrl: listUrl.trim(),
    note,
  }
}

function pickString(f: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = f[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

function pickHyperlinkUrl(f: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = f[k]
    if (typeof v === 'string' && v.length > 0 && /^https?:\/\//i.test(v)) return v
    if (typeof v === 'object' && v && 'Url' in (v as object)) {
      const url = (v as { Url?: unknown }).Url
      if (typeof url === 'string' && url.length > 0) return url
    }
  }
  return ''
}

/** Walk every field looking for the first non-empty string outside `skip`. */
function scanFirstNonEmptyString(f: Record<string, unknown>, skip: string[]): string {
  const skipSet = new Set(skip)
  for (const [k, v] of Object.entries(f)) {
    if (skipSet.has(k) || k.startsWith('@')) continue
    if (typeof v === 'string' && v.length > 0 && !/^https?:\/\//i.test(v)) return v
  }
  return ''
}

/** Walk every field looking for the first SharePoint hyperlink object (or http(s) string). */
function scanFirstHyperlinkUrl(f: Record<string, unknown>, skip: string[]): string {
  const skipSet = new Set(skip)
  for (const [k, v] of Object.entries(f)) {
    if (skipSet.has(k) || k.startsWith('@')) continue
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
    if (typeof v === 'object' && v && 'Url' in (v as object)) {
      const url = (v as { Url?: unknown }).Url
      if (typeof url === 'string' && url.length > 0) return url
    }
  }
  return ''
}

/**
 * Pull the `/Lists/<name>` segment out of a SharePoint list webUrl. Returns
 * the URL-decoded segment, or null if the URL doesn't contain `/Lists/`.
 */
function extractListSegmentFromWebUrl(webUrl: string): string | null {
  try {
    const u = new URL(webUrl)
    const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const i = segs.findIndex((s) => s.toLowerCase() === 'lists')
    if (i === -1 || i + 1 >= segs.length) return null
    return segs[i + 1]
  } catch {
    return null
  }
}

// ── URL parsing (exported for testing) ───────────────────────────────

/**
 * Parse a SharePoint list URL into the pieces we need to call Graph.
 *
 * Expected shape:
 *   https://<host>/<site-path>/Lists/<list-name>[/AllItems.aspx][?...]
 *
 *   → hostname = "<host>" (lower-cased)
 *   → sitePath = "/<site-path>"   (server-relative; leading slash kept)
 *   → listName = "<list-name>"    (URL-decoded)
 *
 * Returns null when the URL doesn't contain a `/Lists/<name>` segment or
 * the host is missing.
 */
export function parseSharepointListUrl(raw: string): {
  hostname: string
  sitePath: string
  listName: string
} | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const hostname = u.hostname.toLowerCase()
  if (!hostname) return null

  const segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  // Find the "Lists" segment (case-insensitive) and the next segment as listName.
  const listsIdx = segments.findIndex((s) => s.toLowerCase() === 'lists')
  if (listsIdx === -1 || listsIdx + 1 >= segments.length) return null
  const listName = segments[listsIdx + 1]
  if (!listName) return null

  const sitePath = '/' + segments.slice(0, listsIdx).join('/')
  return { hostname, sitePath: sitePath === '/' ? '' : sitePath, listName }
}

// ── Helpers (exported for testing) ───────────────────────────────────

export function buildPredictedStem(args: { code: string; title: string; version: string }): string {
  const code = args.code.replace(/[/\\]/g, ' ').trim()
  const title = args.title.trim()
  const version = String(args.version).trim()
  return `${code} - ${title} - v${version}`
}

export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function buildTitleTokens(title: string): string[] {
  return title
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && /\p{L}/u.test(t))
}

export function titleOverlapScore(filename: string, titleTokens: string[]): number {
  if (titleTokens.length === 0) return 0
  let present = 0
  for (const t of titleTokens) {
    if (filename.includes(t)) present++
  }
  return present / titleTokens.length
}

export function buildVersionRegex(version: string): RegExp | null {
  const m = version.match(/(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return new RegExp(`v0*${n}(?!\\d)`, 'i')
}

export function bumpVersion(version: string): string | null {
  const m = version.match(/(\d+)/)
  if (!m) return null
  const n = m[1]
  const next = (parseInt(n, 10) + 1).toString().padStart(n.length, '0')
  return version.slice(0, m.index!) + next + version.slice(m.index! + n.length)
}

export function buildCodeTokenRegex(code: string): RegExp {
  const tokens = code
    .normalize('NFC')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
  if (tokens.length === 0) return /(?!)/
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`(^|[^a-z0-9])${escaped.join('[^a-z0-9]+')}([^a-z0-9]|$)`, 'i')
}

interface SearchResponse {
  value: {
    hitsContainers: {
      hits: SearchHit[]
    }[]
  }[]
}

interface SearchHit {
  resource?: {
    id?: string
    name?: string
    eTag?: string
    size?: number
    webUrl?: string
    parentReference?: { driveId?: string }
  }
}
