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

export type LadderRung = keyof typeof OPENCODE_LADDER_KEYS
export const LADDER_RUNGS = Object.keys(OPENCODE_LADDER_KEYS) as LadderRung[]

export type OpencodeLadder = Record<LadderRung, string>

export interface LadderRungDetail {
  rung: LadderRung
  value: string
  /** 'db' when an admin has pinned this rung; 'env' when the default applies. */
  source: 'db' | 'env'
  /** The env default, shown in the UI so an admin can see what "Reset" restores. */
  envDefault: string
  updatedByEmail: string | null
  updatedAt: string | null
}

/**
 * How long a resolved ladder is trusted without re-reading `app_settings`.
 * The read is three PK lookups, but it sits on the chat hot path, so we cache
 * it. The writing instance invalidates its own cache immediately; other
 * instances (if the backend is ever scaled out) converge within one TTL.
 */
const CACHE_TTL_MS = 30_000

/**
 * Reads and writes the admin-editable chat-model ladder. A rung with no row in
 * `app_settings` falls back to its env var, so a fresh database behaves exactly
 * as it did before this table existed.
 */
export class ChatSettingsService {
  private cache: { ladder: OpencodeLadder; expiresAt: number } | null = null

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

  private async readOverrides(): Promise<Map<string, { value: string; updatedByEmail: string | null; updatedAt: Date }>> {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: Object.values(OPENCODE_LADDER_KEYS) } },
    })
    return new Map(rows.map((r) => [r.key, r]))
  }

  /**
   * Hot path (called once per chat request via ChatService.resolveChatModel).
   * Cached for CACHE_TTL_MS.
   */
  async opencodeLadder(): Promise<OpencodeLadder> {
    const now = Date.now()
    if (this.cache && this.cache.expiresAt > now) return this.cache.ladder

    const overrides = await this.readOverrides()
    const ladder = Object.fromEntries(
      LADDER_RUNGS.map((rung) => [
        rung,
        overrides.get(OPENCODE_LADDER_KEYS[rung])?.value ?? this.envDefault(rung),
      ]),
    ) as OpencodeLadder

    this.cache = { ladder, expiresAt: now + CACHE_TTL_MS }
    return ladder
  }

  /**
   * Admin read. Bypasses the cache — an admin who just saved should never be
   * shown a stale value, and this path runs at most a few times a day.
   */
  async opencodeLadderDetail(): Promise<LadderRungDetail[]> {
    const overrides = await this.readOverrides()
    return LADDER_RUNGS.map((rung) => {
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
  }

  /** Pin all three rungs. Atomic: a partial write would leave a torn ladder. */
  async setOpencodeLadder(ladder: OpencodeLadder, updatedByEmail: string | null): Promise<void> {
    await this.prisma.$transaction(
      LADDER_RUNGS.map((rung) => {
        const key = OPENCODE_LADDER_KEYS[rung]
        const value = ladder[rung]
        return this.prisma.appSetting.upsert({
          where: { key },
          create: { key, value, updatedByEmail },
          update: { value, updatedByEmail },
        })
      }),
    )
    this.cache = null
  }

  /** Drop all overrides — the ladder reverts to the env defaults. */
  async resetOpencodeLadder(): Promise<void> {
    await this.prisma.appSetting.deleteMany({
      where: { key: { in: Object.values(OPENCODE_LADDER_KEYS) } },
    })
    this.cache = null
  }
}
