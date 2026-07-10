import { AppConfig } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

/**
 * The three rungs of the OpenCode fallback ladder, in order. `app_settings`
 * keys are dotted and stable — renaming one orphans the stored override.
 */
export const OPENCODE_LADDER_KEYS = {
  primary: 'opencode.chat_model',
  fallback: 'opencode.chat_fallback_model',
  secondFallback: 'opencode.chat_second_fallback_model',
} as const

/**
 * Namespace prepended to every rung when calling the gateway, e.g. a prefix of
 * `opencode-go` turns the catalog id `glm-5.2` into `opencode-go/glm-5.2`.
 *
 * Stored apart from the rungs on purpose: `GET /models` advertises bare ids, so
 * the catalog stays the source of truth for model *names* while the prefix is
 * pure call-time routing. Changing the prefix never invalidates the picked
 * models, and validation keeps comparing bare ids against the bare catalog.
 */
export const OPENCODE_PREFIX_KEY = 'opencode.model_prefix'

/**
 * Prefix used until an admin sets one. Deliberately a code constant rather than
 * an env var: it's a property of the gateway's routing scheme, identical across
 * every deployment, so there's nothing for an operator to tune. Admins who need
 * a different namespace change it at /admin/chat-model.
 */
export const DEFAULT_OPENCODE_MODEL_PREFIX = 'opencode-go'

/** Every app_settings key this service owns. Reset drops exactly these. */
const ALL_KEYS = [...Object.values(OPENCODE_LADDER_KEYS), OPENCODE_PREFIX_KEY]

export type LadderRung = keyof typeof OPENCODE_LADDER_KEYS
export const LADDER_RUNGS = Object.keys(OPENCODE_LADDER_KEYS) as LadderRung[]

export type OpencodeLadder = Record<LadderRung, string>

export interface SettingDetail<T extends string = string> {
  value: T
  /** 'db' when an admin has pinned this; 'env' when the default applies. */
  source: 'db' | 'env'
  /** The env default, shown in the UI so an admin can see what "Reset" restores. */
  envDefault: T
  updatedByEmail: string | null
  updatedAt: string | null
}

export interface LadderRungDetail extends SettingDetail {
  rung: LadderRung
}

/**
 * Trim surrounding whitespace and slashes so `/opencode-go/` and `opencode-go`
 * both yield the same joined id. Empty string means "no prefix".
 */
export function normalizePrefix(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
}

/** Join a prefix and a bare catalog id into the id the gateway expects. */
export function applyPrefix(prefix: string, modelId: string): string {
  const p = normalizePrefix(prefix)
  return p ? `${p}/${modelId}` : modelId
}

/**
 * How long a resolved ladder is trusted without re-reading `app_settings`.
 * The read is a handful of PK lookups, but it sits on the chat hot path, so we
 * cache it. The writing instance invalidates its own cache immediately; other
 * instances (if the backend is ever scaled out) converge within one TTL.
 */
const CACHE_TTL_MS = 30_000

interface ResolvedConfig {
  ladder: OpencodeLadder
  prefix: string
}

/**
 * Reads and writes the admin-editable chat-model ladder and its call-time
 * prefix. A setting with no row in `app_settings` falls back to its env var,
 * so a fresh database behaves exactly as it did before this table existed.
 */
export class ChatSettingsService {
  private cache: { config: ResolvedConfig; expiresAt: number } | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  /** The env default for a rung — the value used when no override is stored. */
  private envDefault(rung: LadderRung): string {
    switch (rung) {
      case 'primary':
        return this.config.opencodeChatModel
      case 'fallback':
        return this.config.opencodeChatFallbackModel
      case 'secondFallback':
        return this.config.opencodeChatSecondFallbackModel
    }
  }

  private async readOverrides(): Promise<
    Map<string, { value: string; updatedByEmail: string | null; updatedAt: Date }>
  > {
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: ALL_KEYS } } })
    return new Map(rows.map((r) => [r.key, r]))
  }

  /**
   * Hot path (called once per chat request via ChatService.resolveChatModel).
   * Cached for CACHE_TTL_MS.
   */
  async opencodeConfig(): Promise<ResolvedConfig> {
    const now = Date.now()
    if (this.cache && this.cache.expiresAt > now) return this.cache.config

    const overrides = await this.readOverrides()
    const ladder = Object.fromEntries(
      LADDER_RUNGS.map((rung) => [
        rung,
        overrides.get(OPENCODE_LADDER_KEYS[rung])?.value ?? this.envDefault(rung),
      ]),
    ) as OpencodeLadder
    const prefix = normalizePrefix(
      overrides.get(OPENCODE_PREFIX_KEY)?.value ?? DEFAULT_OPENCODE_MODEL_PREFIX,
    )

    const config = { ladder, prefix }
    this.cache = { config, expiresAt: now + CACHE_TTL_MS }
    return config
  }

  /**
   * The ordered ids to hand the gateway: primary → fallback → second fallback,
   * each already prefixed. This is the only place the prefix is applied.
   */
  async resolvedLadder(): Promise<string[]> {
    const { ladder, prefix } = await this.opencodeConfig()
    return LADDER_RUNGS.map((rung) => applyPrefix(prefix, ladder[rung]))
  }

  /**
   * Admin read. Bypasses the cache — an admin who just saved should never be
   * shown a stale value, and this path runs at most a few times a day.
   */
  async opencodeDetail(): Promise<{ ladder: LadderRungDetail[]; prefix: SettingDetail }> {
    const overrides = await this.readOverrides()

    const ladder = LADDER_RUNGS.map((rung) => {
      const row = overrides.get(OPENCODE_LADDER_KEYS[rung])
      return {
        rung,
        value: row?.value ?? this.envDefault(rung),
        source: row ? ('db' as const) : ('env' as const),
        envDefault: this.envDefault(rung),
        updatedByEmail: row?.updatedByEmail ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }
    })

    const prefixRow = overrides.get(OPENCODE_PREFIX_KEY)
    const prefix: SettingDetail = {
      value: normalizePrefix(prefixRow?.value ?? DEFAULT_OPENCODE_MODEL_PREFIX),
      source: prefixRow ? 'db' : 'env',
      envDefault: DEFAULT_OPENCODE_MODEL_PREFIX,
      updatedByEmail: prefixRow?.updatedByEmail ?? null,
      updatedAt: prefixRow?.updatedAt.toISOString() ?? null,
    }

    return { ladder, prefix }
  }

  /**
   * Pin the ladder and prefix together. Atomic: a partial write would leave the
   * rungs pointing at a namespace that no longer matches.
   *
   * An empty prefix is a meaningful choice ("call the gateway with bare ids"),
   * so it's stored as a row rather than falling back to the env var.
   */
  async setOpencodeConfig(
    input: { ladder: OpencodeLadder; prefix: string },
    updatedByEmail: string | null,
  ): Promise<void> {
    const entries: [string, string][] = [
      ...LADDER_RUNGS.map((rung): [string, string] => [
        OPENCODE_LADDER_KEYS[rung],
        input.ladder[rung],
      ]),
      [OPENCODE_PREFIX_KEY, normalizePrefix(input.prefix)],
    ]

    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.appSetting.upsert({
          where: { key },
          create: { key, value, updatedByEmail },
          update: { value, updatedByEmail },
        }),
      ),
    )
    this.cache = null
  }

  /** Drop all overrides — ladder and prefix revert to the env defaults. */
  async resetOpencodeConfig(): Promise<void> {
    await this.prisma.appSetting.deleteMany({ where: { key: { in: ALL_KEYS } } })
    this.cache = null
  }
}
