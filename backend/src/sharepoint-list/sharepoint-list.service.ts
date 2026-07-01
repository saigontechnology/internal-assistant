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
    const normStem = normalizeForMatch(stem)
    const normCode = normalizeForMatch(args.code)
    const codeRegex = buildCodeTokenRegex(args.code)
    const versionRegex = buildVersionRegex(args.version)
    const bumpedVersion = bumpVersion(args.version)
    const bumpedVersionRegex = bumpedVersion ? buildVersionRegex(bumpedVersion) : null

    // Placeholder codes (e.g. "n/a (Orchard)", "N/A") carry no identifier we
    // can match against the filename — the real signal lives in the Title
    // column instead. Detect those and route through title-only matching.
    const isPlaceholderCode = /^\s*n\s*\/?\s*a\b/i.test(args.code)
    const titleTokens = buildTitleTokens(args.title)
    // Anything inside `(…)` in the code field is treated as a secondary hint
    // ("n/a (Orchard)" → "orchard"). Boosts title-overlap score when present
    // in the filename — helps disambiguate same-title files across offices.
    const parensHint = (args.code.match(/\(([^)]+)\)/)?.[1] ?? '')
      .trim()
      .toLowerCase()

    // Pick the best candidate from a result set. Tiers in priority order:
    //   1. startsWith(predicted stem)    — perfect prefix; only when title also matches
    //   2. code AND version present       — handles title divergence (e.g. filename
    //                                       drops "Hướng dẫn" prefix the list has)
    //   3. code AND bumped-version        — list Ver lags behind actual file (01 → 02)
    //   4. code only                      — last resort; risks picking wrong version
    //                                       if multiple version siblings exist
    //   5. title-overlap score ≥ 0.7      — handles placeholder codes; also a final
    //                                       safety net when the code isn't in the
    //                                       filename at all
    const pickBest = (hits: SearchHit[]): SearchHit | undefined => {
      const named = hits.filter((h) => h.resource?.name)
      const norm = (h: SearchHit) => normalizeForMatch(h.resource!.name!)

      // Code-based tiers — skipped entirely for placeholder codes since the
      // code itself is meaningless ("n/a (Orchard)" isn't in any filename).
      if (!isPlaceholderCode) {
        const codeMatches = named.filter(
          (h) => codeRegex.test(norm(h)) || norm(h).includes(normCode),
        )
        const codeHit =
          named.find((h) => norm(h).startsWith(normStem)) ??
          (versionRegex
            ? codeMatches.find((h) => versionRegex.test(norm(h)))
            : undefined) ??
          (bumpedVersionRegex
            ? codeMatches.find((h) => bumpedVersionRegex.test(norm(h)))
            : undefined) ??
          codeMatches[0]
        if (codeHit) return codeHit
      }

      // Title-overlap tier. Requires ≥3 title tokens so the score is meaningful.
      if (titleTokens.length >= 3) {
        let best: { hit: SearchHit | undefined; score: number } = {
          hit: undefined,
          score: 0,
        }
        for (const h of named) {
          let score = titleOverlapScore(norm(h), titleTokens)
          if (parensHint && norm(h).includes(parensHint)) score += 0.3
          if (score > best.score) best = { hit: h, score }
        }
        if (best.score >= 0.7) return best.hit
      }

      return undefined
    }

    // Shot 1 — strict quoted-phrase search on the full predicted stem.
    // Skipped for placeholder codes (the stem is "n a (Orchard) - …", noise).
    let items: SearchHit[] = []
    let matched: SearchHit | undefined
    if (!isPlaceholderCode) {
      items = await this.searchDriveItems(tokens, `"${stem}"`, 5)
      matched = pickBest(items)
    }

    // Shot 2 — codes containing `.` (e.g. "QT-HR.13", "HD-HR.00.20") often
    // zero-hit the quoted-phrase search because SP Search tokenizes on the
    // period. Re-query with just the code unquoted; pickBest handles the
    // version disambiguation (e.g. picks v02 over v01 archive sibling) and
    // the title divergence cases (filename drops "Hướng dẫn" prefix that
    // the list Title carries). Skipped for placeholder codes.
    if (!matched?.resource && !isPlaceholderCode) {
      const fallback = await this.searchDriveItems(tokens, args.code, 25)
      matched = pickBest(fallback)
      if (matched) items = fallback
    }

    // Shot 3 — full title as a quoted phrase. Hits when the file's name
    // contains the entire list Title verbatim. Gated to ≥3 tokens so the
    // phrase is discriminating enough.
    const titleWords = args.title.trim().split(/\s+/)
    if (!matched?.resource && titleWords.length >= 3) {
      const titleHits = await this.searchDriveItems(tokens, `"${args.title.trim()}"`, 25)
      matched = pickBest(titleHits)
      if (matched) items = titleHits
    }

    // Shot 4 — first 4 title tokens quoted. Handles files whose names
    // contain only the *leading* portion of the list Title (e.g. list says
    // "Sơ đồ chỗ ngồi - văn phòng Orchard", file is named "Orchard - Sơ
    // đồ chỗ ngồi" — the leading 4 tokens appear in the file, but the full
    // phrase doesn't). Skipped when the full title already fit in shot 3.
    if (!matched?.resource && titleWords.length > 4) {
      const firstFour = titleWords.slice(0, 4).join(' ')
      const partialHits = await this.searchDriveItems(tokens, `"${firstFour}"`, 25)
      matched = pickBest(partialHits)
      if (matched) items = partialHits
    }

    // Shot 5 — parens hint, unquoted. Last resort for placeholder codes
    // where the real identifier lives inside `(…)`. For "n/a (Orchard)"
    // we search "Orchard" and let the title-overlap scorer disambiguate
    // among the returned hits.
    if (!matched?.resource && parensHint) {
      const hintHits = await this.searchDriveItems(tokens, parensHint, 25)
      matched = pickBest(hintHits)
      if (matched) items = hintHits
    }

    if (!matched?.resource) {
      // Diagnostic: when Strategy H misses, print the predicted stem and the
      // top hit names so we can see whether the file was returned at all and,
      // if so, exactly how the actual name diverges from our prefix.
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
          // `id` MUST be explicit — Graph Search only returns selected fields.
          // Omitting it caused every row to look like a 'pending_access' miss
          // because resolveByCode's null-check on r.id fired.
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

/**
 * Tokenize a title for overlap scoring. Splits on any non-letter/non-digit
 * run (preserving Vietnamese diacritics via the Unicode property escapes),
 * lowercases, and keeps tokens with ≥2 characters that contain at least
 * one letter. Pure-numeric tokens are dropped — they match too freely
 * against years, version numbers, dates baked into filenames.
 */
export function buildTitleTokens(title: string): string[] {
  return title
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && /\p{L}/u.test(t))
}

/**
 * Fraction of title tokens present (as substrings) in the candidate
 * filename. Returns 0..1. Used as the last-resort tier in pickBest for
 * rows where the code can't be matched against the filename (placeholder
 * codes like "n/a (Orchard)", or files whose names diverge wildly from
 * the listed Code).
 */
export function titleOverlapScore(filename: string, titleTokens: string[]): number {
  if (titleTokens.length === 0) return 0
  let present = 0
  for (const t of titleTokens) {
    if (filename.includes(t)) present++
  }
  return present / titleTokens.length
}

/**
 * Build a regex that matches the version segment of a filename. Accepts any
 * `v<digits>` whose integer value equals the version's leading integer,
 * regardless of zero-padding. So `"02"` matches `v2`, `v02`, `v002` — but
 * NOT `v20` or `v21` (right-anchored to a non-digit or end-of-string).
 *
 * Returns null when the version has no integer (defensive — every list row
 * in practice has a numeric Ver, but the column type is string).
 */
export function buildVersionRegex(version: string): RegExp | null {
  const m = version.match(/(\d+)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return new RegExp(`v0*${n}(?!\\d)`, 'i')
}

/**
 * Increment the first integer run in a version string by 1, preserving
 * zero-pad width. Returns null when the version has no integer at all.
 *
 *   "01"   → "02"
 *   "09"   → "10"      (width preserved, no truncation when value overflows)
 *   "1"    → "2"
 *   "1.0"  → "2.0"     (only the leading integer is bumped)
 *   "v3"   → "v4"
 *   ""     → null
 *   "abc"  → null
 */
export function bumpVersion(version: string): string | null {
  const m = version.match(/(\d+)/)
  if (!m) return null
  const n = m[1]
  const next = (parseInt(n, 10) + 1).toString().padStart(n.length, '0')
  return version.slice(0, m.index!) + next + version.slice(m.index! + n.length)
}

/**
 * Build a tolerant regex from a code like "HD-HR.00.20": splits on any
 * non-alphanumeric run and accepts any non-alnum separator between the
 * resulting tokens in the candidate string. Handles SharePoint filenames
 * that flattened dots to hyphens/underscores at upload time.
 *
 * Operates against `normalizeForMatch`-ed input (lowercased, NFC, single-
 * spaced), so tokens are already lower-case.
 */
export function buildCodeTokenRegex(code: string): RegExp {
  const tokens = code
    .normalize('NFC')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
  if (tokens.length === 0) return /(?!)/ // never matches
  const escaped = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // (^|non-alnum) before the first token, (non-alnum|$) after the last,
  // non-alnum between tokens — anchors so we don't accept "hd" in "shdr".
  return new RegExp(
    `(^|[^a-z0-9])${escaped.join('[^a-z0-9]+')}([^a-z0-9]|$)`,
    'i',
  )
}

// Minimal shape of /search/query response — typed locally so we don't drag in
// the @microsoft/microsoft-graph-types union of every possible entity.
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
