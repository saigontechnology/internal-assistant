import { AppConfig } from '../config/app-config.service.js'
import { GraphTokenProvider } from './graph-token-provider.js'

/**
 * Talks to the Microsoft Graph endpoints the watcher needs:
 *   - resolve the configured list to a (siteId, listId) tuple (cached in-process)
 *   - paginate all items with $expand=fields
 *   - resolve a list row to a driveItem via Strategy H (predicted filename)
 *   - download driveItem content
 *
 * All methods take a `GraphTokenProvider` rather than a raw token so the
 * provider can refresh tokens mid-sync if needed (Graph tokens last ~1h;
 * a full 375-row sync should fit well inside that, but we don't assume it).
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

export class SharepointListService {
  /** Resolved once and cached for the lifetime of this service instance. */
  private locationCache: { siteId: string; listId: string } | null = null

  constructor(private readonly config: AppConfig) {}

  /** Reset the (siteId, listId) cache. Useful when the list name changes. */
  resetCache(): void {
    this.locationCache = null
  }

  // ── Public methods ────────────────────────────────────────────────

  /** Resolve and cache the (siteId, listId) for the configured list. */
  async resolveLocation(tokens: GraphTokenProvider): Promise<{ siteId: string; listId: string }> {
    if (this.locationCache) return this.locationCache
    const cfg = this.config
    const site = await this.graphGet<{ id: string }>(
      tokens,
      `/sites/${cfg.sharepointHostname}:${cfg.sharepointSitePath}`,
    )
    const lists = await this.graphGet<{ value: { id: string; displayName: string }[] }>(
      tokens,
      `/sites/${site.id}/lists?$filter=${encodeURIComponent(`displayName eq '${cfg.sharepointListName}'`)}`,
    )
    const list = lists.value[0]
    if (!list) {
      throw new Error(
        `SharePoint list "${cfg.sharepointListName}" not found at site ${cfg.sharepointSitePath}`,
      )
    }
    this.locationCache = { siteId: site.id, listId: list.id }
    return this.locationCache
  }

  /**
   * Iterate every row in the list, following @odata.nextLink. Yields rows in
   * batches so callers can stream them into the DB without buffering all 375
   * rows in memory.
   */
  async *iterateItems(tokens: GraphTokenProvider): AsyncGenerator<ListRow, void, void> {
    const { siteId, listId } = await this.resolveLocation(tokens)
    type Page = { value: ListRow[]; '@odata.nextLink'?: string }
    let next: string | null = `/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`
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
   * Returns null when:
   *   - search returns 0 hits (file invisible to this identity OR doesn't exist)
   *   - top hits exist but none start with the predicted stem (ambiguous)
   */
  async resolveByCode(
    tokens: GraphTokenProvider,
    args: { code: string; title: string; version: string },
  ): Promise<ResolvedDriveItem | null> {
    const stem = buildPredictedStem(args)
    const hits = await this.graphPost<SearchResponse>(tokens, '/search/query', {
      requests: [
        {
          entityTypes: ['driveItem'],
          query: { queryString: `"${stem}"` },
          // `id` MUST be explicit — Graph Search only returns selected fields.
          // Omitting it caused every row to look like a 'pending_access' miss
          // because resolveByCode's null-check on r.id fired.
          fields: ['id', 'name', 'parentReference', 'eTag', 'size', 'webUrl'],
          from: 0,
          size: 5,
        },
      ],
    })
    const items = hits.value?.[0]?.hitsContainers?.[0]?.hits ?? []
    const normStem = normalizeForMatch(stem)
    const matched = items.find((h) => {
      const name = (h.resource?.name ?? '') as string
      return normalizeForMatch(name).startsWith(normStem)
    })
    if (!matched?.resource) return null
    const r = matched.resource
    const driveId = r.parentReference?.driveId
    if (!driveId || !r.id || !r.name) return null
    return { driveId, itemId: r.id, name: r.name, eTag: r.eTag, size: r.size, webUrl: r.webUrl }
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

// ── Helpers (exported for testing) ───────────────────────────────────

export function buildPredictedStem(args: { code: string; title: string; version: string }): string {
  // `Code` can contain path-y characters (e.g. "PL01/QT-COM.03"); strip them so
  // the filename match isn't confused by a `/` that doesn't exist in the actual
  // file name on disk.
  const code = args.code.replace(/[/\\]/g, ' ').trim()
  const title = args.title.trim()
  const version = String(args.version).trim()
  return `${code} - ${title} - v${version}`
}

export function normalizeForMatch(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Minimal shape of /search/query response — typed locally so we don't drag in
// the @microsoft/microsoft-graph-types union of every possible entity.
interface SearchResponse {
  value: {
    hitsContainers: {
      hits: {
        resource?: {
          id?: string
          name?: string
          eTag?: string
          size?: number
          webUrl?: string
          parentReference?: { driveId?: string }
        }
      }[]
    }[]
  }[]
}
