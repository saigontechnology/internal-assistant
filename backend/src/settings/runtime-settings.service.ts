import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { AppConfig, normalizeProfileField } from '../config/app-config.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { SETTING_DEFS, SETTING_DEFS_BY_KEY } from './setting-defs.js'

/**
 * How often the in-memory snapshot is re-read from `app_settings`. The writing
 * instance refreshes immediately; a second instance (if the backend is ever
 * scaled out) converges within one tick.
 */
const REFRESH_MS = 30_000

export interface SettingRow {
  value: string
  updatedByEmail: string | null
  updatedAt: Date
}

/**
 * Admin-editable settings, backed by `app_settings` and served from an
 * in-memory snapshot.
 *
 * The snapshot exists because every consumer of these values reads them
 * synchronously, deep inside request handling (`documents.service.ts` while
 * chunking, `chat.service.ts` while resolving a model). Making those paths
 * async to await a DB read would be a large, risky refactor for values that
 * change a few times a year. Instead we load once at boot, refresh on write,
 * and re-read on a timer.
 *
 * Every getter mirrors the AppConfig getter it shadows, and falls back to it
 * when no override is stored — so an empty `app_settings` behaves exactly as
 * the env-only build did.
 */
export class RuntimeSettingsService implements OnModuleInit, OnModuleDestroy {
  private snapshot = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh()
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        // A failed refresh is survivable: we keep serving the last snapshot.
        console.error('[settings] snapshot refresh failed:', (err as Error).message)
      })
    }, REFRESH_MS)
    // Don't hold the event loop open in tests / short-lived processes.
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Reload the snapshot from Postgres. Called at boot, on a timer, and on write. */
  async refresh(): Promise<void> {
    const keys = SETTING_DEFS.map((d) => d.key)
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: keys } } })
    this.snapshot = new Map(rows.map((r) => [r.key, r.value]))
  }

  /** Fresh read straight from Postgres, bypassing the snapshot. Admin GET only. */
  async readOverrides(): Promise<Map<string, SettingRow>> {
    const keys = SETTING_DEFS.map((d) => d.key)
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: keys } } })
    return new Map(rows.map((r) => [r.key, r]))
  }

  /** Raw override, or undefined when the env default applies. */
  private raw(key: string): string | undefined {
    return this.snapshot.get(key)
  }

  /**
   * Parse a numeric override. A stored value that doesn't parse — or falls
   * outside the def's bounds — is ignored in favour of the env default rather
   * than propagating a NaN into a chunker or a date computation.
   */
  private num(key: string): number | undefined {
    const raw = this.raw(key)
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) return undefined
    const def = SETTING_DEFS_BY_KEY.get(key)
    if (def?.min !== undefined && n < def.min) return undefined
    if (def?.max !== undefined && n > def.max) return undefined
    return n
  }

  /** Persist overrides and refresh the snapshot so the writer sees them at once. */
  async setMany(entries: [string, string][], updatedByEmail: string | null): Promise<void> {
    await this.prisma.$transaction(
      entries.map(([key, value]) =>
        this.prisma.appSetting.upsert({
          where: { key },
          create: { key, value, updatedByEmail },
          update: { value, updatedByEmail },
        }),
      ),
    )
    await this.refresh()
  }

  /** Drop overrides for the given keys (all editable keys when omitted). */
  async reset(keys?: string[]): Promise<void> {
    const target = keys ?? SETTING_DEFS.map((d) => d.key)
    await this.prisma.appSetting.deleteMany({ where: { key: { in: target } } })
    await this.refresh()
  }

  // ── Typed getters. Each shadows the AppConfig getter of the same name. ──

  get chatModel(): string {
    return this.raw('chat.model') ?? this.config.chatModel
  }
  get geminiChatModel(): string {
    return this.raw('chat.gemini_model') ?? this.config.geminiChatModel
  }
  get geminiChatFallbackModel(): string {
    return this.raw('chat.gemini_fallback_model') ?? this.config.geminiChatFallbackModel
  }
  get geminiChatSecondFallbackModel(): string {
    return (
      this.raw('chat.gemini_second_fallback_model') ?? this.config.geminiChatSecondFallbackModel
    )
  }
  get chatMaxSteps(): number {
    return this.num('chat.max_steps') ?? this.config.chatMaxSteps
  }

  get chunkSize(): number {
    return this.num('ingest.chunk_size') ?? this.config.chunkSize
  }
  /**
   * Clamped below the effective chunk size. The two are stored independently,
   * so a chunk-size reduction could otherwise leave an overlap ≥ size, which
   * makes the splitter loop forever.
   */
  get chunkOverlap(): number {
    const overlap = this.num('ingest.chunk_overlap') ?? this.config.chunkOverlap
    return Math.min(overlap, Math.max(0, this.chunkSize - 1))
  }

  get sharepointHostname(): string {
    return this.raw('sharepoint.tenant_hostname') ?? this.config.sharepointHostname
  }
  get sharepointSitePath(): string {
    return this.raw('sharepoint.site_path') ?? this.config.sharepointSitePath
  }
  get sharepointRegistryListName(): string {
    return this.raw('sharepoint.registry_list_name') ?? this.config.sharepointRegistryListName
  }
  get sharepointRegistryIncrementalWindowDays(): number {
    return (
      this.num('sharepoint.incremental_window_days') ??
      this.config.sharepointRegistryIncrementalWindowDays
    )
  }

  get userSyncIntervalDays(): number {
    return this.num('users.sync_interval_days') ?? this.config.userSyncIntervalDays
  }
  /** Normalized, exactly like AppConfig.defaultProfile — these are join keys. */
  get defaultProfile(): { jobTitle: string; department: string } {
    return {
      jobTitle: normalizeProfileField(
        this.raw('users.default_job_title') ?? this.config.rawDefaultJobTitle,
      ),
      department: normalizeProfileField(
        this.raw('users.default_department') ?? this.config.rawDefaultDepartment,
      ),
    }
  }

  /** The effective value of a key as a string — used by the admin GET. */
  effective(key: string): string {
    const def = SETTING_DEFS_BY_KEY.get(key)
    if (!def) throw new Error(`Unknown setting key: ${key}`)
    return this.raw(key) ?? def.envDefault(this.config)
  }

  envDefault(key: string): string {
    const def = SETTING_DEFS_BY_KEY.get(key)
    if (!def) throw new Error(`Unknown setting key: ${key}`)
    return def.envDefault(this.config)
  }
}
