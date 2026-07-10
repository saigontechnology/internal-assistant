import { AppConfig } from './app-config.service.js'

/**
 * The OpenCode gateway's model catalog (`GET {OPENCODE_API_BASE}/models`),
 * the OpenAI-compatible `{object: "list", data: [...]}` shape.
 *
 * Note the id format: the gateway returns **bare** ids (`glm-5.2`,
 * `kimi-k2.6`), not the `<provider>/<model>` form the OPENCODE_CHAT_MODEL
 * env defaults use. Anything the admin picks here is stored verbatim, so
 * the picker is also the fix for a mis-prefixed env default.
 */
export interface OpencodeModel {
  id: string
  ownedBy: string | null
}

/** Thrown when the catalog can't be fetched or parsed. Never cached. */
export class OpencodeCatalogError extends Error {}

/**
 * Process-wide cache. The catalog is a property of the gateway, not of any
 * user or request, and it changes on the order of weeks — so one fetch per
 * five minutes per process is plenty.
 */
const CATALOG_TTL_MS = 5 * 60_000
let cache: { models: OpencodeModel[]; expiresAt: number } | null = null

/** Exposed for tests / manual cache busting from the admin refresh button. */
export function invalidateOpencodeCatalog(): void {
  cache = null
}

export async function fetchOpencodeModels(
  config: AppConfig,
  opts: { force?: boolean } = {},
): Promise<OpencodeModel[]> {
  const now = Date.now()
  if (!opts.force && cache && cache.expiresAt > now) return cache.models

  const url = `${config.opencodeApiBase.replace(/\/+$/, '')}/models`
  // The gateway serves the catalog unauthenticated, but send the key when we
  // have one so a future tightening of that endpoint doesn't break us.
  const headers: Record<string, string> = {}
  const apiKey = config.opencodeApiKey
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res: Response
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw new OpencodeCatalogError(
      `Could not reach the OpenCode model catalog at ${url}: ${(err as Error).message}`,
    )
  }
  if (!res.ok) {
    throw new OpencodeCatalogError(`OpenCode model catalog returned HTTP ${res.status}`)
  }

  const body = (await res.json()) as { data?: unknown }
  if (!Array.isArray(body.data)) {
    throw new OpencodeCatalogError('OpenCode model catalog returned an unexpected shape')
  }

  const models: OpencodeModel[] = body.data
    .filter((m): m is { id: string; owned_by?: unknown } => {
      return !!m && typeof (m as { id?: unknown }).id === 'string'
    })
    .map((m) => ({
      id: m.id,
      ownedBy: typeof m.owned_by === 'string' ? m.owned_by : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  // An empty catalog is almost certainly a gateway fault, not a real answer.
  // Treat it as an error so we never cache it and never render an empty picker.
  if (models.length === 0) {
    throw new OpencodeCatalogError('OpenCode model catalog is empty')
  }

  cache = { models, expiresAt: now + CATALOG_TTL_MS }
  return models
}
