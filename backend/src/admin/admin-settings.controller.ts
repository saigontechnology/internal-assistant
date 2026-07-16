import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import { AppConfig } from '../config/app-config.service.js'
import { EmbeddingsService } from '../embeddings/embeddings.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import {
  ENV_VIEW,
  maskSecret,
  redactUrlCredentials,
  SETTING_DEFS,
  SETTING_DEFS_BY_KEY,
  SETTING_GROUPS,
  type SettingValidationContext,
} from '../settings/setting-defs.js'

interface PutSettingsBody {
  /** Sparse map of key → new value. Only the keys present are written. */
  values?: Record<string, string>
}

interface ResetBody {
  /** Keys to drop. Omit to reset every editable setting. */
  keys?: string[]
}

/**
 * `/api/admin/settings` — the generic runtime-configuration surface.
 *
 * Editable settings come from the SETTING_DEFS registry; everything else is
 * exposed read-only so an admin can see what production is actually running
 * without shelling into the box. Secrets are masked server-side and never
 * leave in full.
 */
@Controller('admin/settings')
@UseGuards(AdminGuard)
export class AdminSettingsController {
  constructor(
    @Inject(RuntimeSettingsService) private readonly settings: RuntimeSettingsService,
    @Inject(AppConfig) private readonly config: AppConfig,
    // Only used to satisfy `validate` hooks — currently the embedding model's
    // output-dimension probe, which is what makes that field safe to expose.
    @Inject(EmbeddingsService) private readonly embeddings: EmbeddingsService,
  ) {}

  @Get('/')
  async get() {
    const overrides = await this.settings.readOverrides()

    const settings = SETTING_DEFS.map((def) => {
      const row = overrides.get(def.key)
      const envDefault = def.envDefault(this.config)
      return {
        key: def.key,
        group: def.group,
        label: def.label,
        help: def.help,
        kind: def.kind,
        envVar: def.envVar,
        min: def.min ?? null,
        max: def.max ?? null,
        danger: def.danger ?? null,
        value: row?.value ?? envDefault,
        source: row ? ('db' as const) : ('env' as const),
        envDefault,
        updatedByEmail: row?.updatedByEmail ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      }
    })

    const environment = ENV_VIEW.map((e) => {
      // Secrets are read straight from process.env and masked — never resolved
      // through AppConfig, so an unmasked value can't leak via a typo here.
      const raw = e.secret ? process.env[e.name] : this.effectiveEnv(e.name)
      return {
        name: e.name,
        secret: e.secret,
        note: e.note ?? null,
        /** Masked for secrets; null when unset. Never the raw secret. */
        value: e.secret ? maskSecret(raw) : (raw ?? null),
        isSet: raw !== undefined && raw !== '',
      }
    })

    return { groups: SETTING_GROUPS, settings, environment }
  }

  /**
   * The value the app is actually running with, not the raw env var.
   *
   * Zod applies defaults inside validateEnv() without writing them back to
   * `process.env`, so reading process.env directly would render an unset-but-
   * defaulted var as "not set" — precisely the wrong answer for the question
   * this panel exists to answer ("why is prod on openai?"). Resolve through
   * AppConfig, which is what the rest of the app reads.
   */
  private effectiveEnv(name: string): string | undefined {
    switch (name) {
      case 'NODE_ENV':
        return this.config.isProd ? 'production' : 'development'
      case 'CHAT_PROVIDER':
        return this.config.chatProvider
      case 'OPENAI_API_BASE':
        return this.config.openaiApiBase
      case 'OPENAI_HOST_OVERRIDE':
        return this.config.openaiHostOverride
      case 'OPENCODE_API_BASE':
        return this.config.opencodeApiBase
      case 'FRONTEND_URL':
        return this.config.frontendUrl
      case 'AZURE_CLIENT_ID':
        return this.config.azureClientId
      case 'AZURE_TENANT_ID':
        return this.config.azureTenantId
      case 'AZURE_REDIRECT_URI':
        return this.config.azureRedirectUri
      case 'ADMIN_EMAILS':
        return this.config.adminEmails.join(', ')
      case 'REDIS_URL':
        // May carry a password in prod; show the host, hide the userinfo.
        return redactUrlCredentials(this.config.redisUrl)
      default:
        return process.env[name]
    }
  }

  /**
   * Sparse update. Values are validated against the registry: numbers must
   * parse and sit inside their bounds, strings must be non-empty unless the
   * def allows it. Nothing is written unless every value validates, so a bad
   * field can't leave the config half-applied.
   */
  @Put('/')
  async put(@Req() req: Request, @Body() body: PutSettingsBody) {
    const values = body.values ?? {}
    const entries: [string, string][] = []

    for (const [key, rawValue] of Object.entries(values)) {
      const def = SETTING_DEFS_BY_KEY.get(key)
      if (!def) throw new BadRequestException(`Unknown or non-editable setting: ${key}`)

      const value = (rawValue ?? '').trim()

      if (def.kind === 'number') {
        const n = Number(value)
        if (value === '' || !Number.isFinite(n) || !Number.isInteger(n)) {
          throw new BadRequestException(`${def.label} must be a whole number`)
        }
        if (def.min !== undefined && n < def.min) {
          throw new BadRequestException(`${def.label} must be at least ${def.min}`)
        }
        if (def.max !== undefined && n > def.max) {
          throw new BadRequestException(`${def.label} must be at most ${def.max}`)
        }
        entries.push([key, String(n)])
        continue
      }

      if (!value && !def.allowEmpty) {
        throw new BadRequestException(`${def.label} cannot be empty`)
      }
      entries.push([key, value])
    }

    if (entries.length === 0) throw new BadRequestException('No settings supplied')

    this.assertChunkingCoherent(Object.fromEntries(entries))
    await this.runValidators(entries)

    const session = (req as Request & { session: Session }).session
    await this.settings.setMany(entries, session.username ?? null)
    return this.get()
  }

  /**
   * Run the registry's async `validate` hooks — checks that need to ask
   * something outside the process, so they can't be expressed as a type or a
   * bound. Today that's the embedding model's output dimension, which is only
   * knowable by embedding something and counting.
   *
   * Runs after the cheap synchronous validation and before any write, so a
   * model that fails its probe never reaches `app_settings`. That ordering is
   * the whole point: a wrong-dimension model doesn't fail at write time, it
   * quietly poisons every document embedded after it.
   *
   * Only re-validates keys whose value actually changed. Saving the form with
   * an untouched embedding model shouldn't cost a provider round-trip, and
   * shouldn't fail because the provider happens to be rate-limiting right now.
   */
  private async runValidators(entries: [string, string][]): Promise<void> {
    const ctx: SettingValidationContext = { embeddings: this.embeddings }

    for (const [key, value] of entries) {
      const def = SETTING_DEFS_BY_KEY.get(key)
      if (!def?.validate) continue
      if (value === this.settings.effective(key)) continue

      try {
        await def.validate(value, ctx)
      } catch (err) {
        throw new BadRequestException(`${def.label}: ${(err as Error).message}`)
      }
    }
  }

  /**
   * chunk_overlap ≥ chunk_size makes the splitter fail to advance. The two are
   * separate rows, so a partial update can violate the invariant even when each
   * field is individually in range — check the *effective* pair, blending the
   * incoming values over what's already stored.
   */
  private assertChunkingCoherent(incoming: Record<string, string>): void {
    const size = Number(incoming['ingest.chunk_size'] ?? this.settings.chunkSize)
    const overlap = Number(incoming['ingest.chunk_overlap'] ?? this.settings.chunkOverlap)
    if (overlap >= size) {
      throw new BadRequestException(
        `Chunk overlap (${overlap}) must be smaller than chunk size (${size}).`,
      )
    }
  }

  /** Drop overrides so the listed keys fall back to their env vars. */
  @Post('reset')
  async reset(@Body() body: ResetBody) {
    const keys = body.keys?.length ? body.keys : undefined
    if (keys) {
      const unknown = keys.filter((k) => !SETTING_DEFS_BY_KEY.has(k))
      if (unknown.length) {
        throw new BadRequestException(`Unknown setting(s): ${unknown.join(', ')}`)
      }
    }
    await this.settings.reset(keys)
    return this.get()
  }
}
