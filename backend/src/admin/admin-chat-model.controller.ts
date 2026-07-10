import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import {
  applyPrefix,
  ChatSettingsService,
  LADDER_RUNGS,
  normalizePrefix,
  type OpencodeLadder,
} from '../chat/chat-settings.service.js'
import { AppConfig } from '../config/app-config.service.js'
import {
  fetchOpencodeModels,
  OpencodeCatalogError,
  type OpencodeModel,
} from '../config/opencode-catalog.js'

interface PutConfigBody {
  primary?: string
  fallback?: string
  secondFallback?: string
  /** e.g. "opencode-go". Empty string is valid and means "send bare ids". */
  prefix?: string
}

/**
 * A prefix is a path segment, not a full id. Reject anything that would produce
 * a malformed model id once joined — the gateway's error for that is opaque.
 */
const PREFIX_RE = /^[A-Za-z0-9._-]+$/

/**
 * `/api/admin/chat-model` — the OpenCode model picker.
 *
 * Only the OpenCode ladder and its prefix are editable here. CHAT_PROVIDER
 * itself stays in the env: flipping providers swaps the SDK client that
 * ChatService builds at construction time, so it can't change without a restart.
 */
@Controller('admin/chat-model')
@UseGuards(AdminGuard)
export class AdminChatModelController {
  constructor(
    @Inject(ChatSettingsService) private readonly settings: ChatSettingsService,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  /**
   * Current ladder + prefix + the gateway's catalog.
   *
   * A catalog fetch failure is reported in-band (`catalogError`) rather than
   * as a 5xx: the admin should still be able to see what's configured, and
   * which rungs are pinned, when opencode.ai is unreachable.
   */
  @Get('/')
  async get(@Query('refresh') refresh?: string) {
    const { ladder, prefix } = await this.settings.opencodeDetail()

    let models: OpencodeModel[] = []
    let catalogError: string | null = null
    try {
      models = await fetchOpencodeModels(this.config, { force: refresh === 'true' })
    } catch (err) {
      if (!(err instanceof OpencodeCatalogError)) throw err
      catalogError = err.message
    }

    const known = new Set(models.map((m) => m.id))
    return {
      provider: this.config.chatProvider,
      /** False when CHAT_PROVIDER != opencode — the ladder is stored but inert. */
      active: this.config.chatProvider === 'opencode',
      models,
      catalogError,
      prefix,
      ladder: ladder.map((rung) => ({
        ...rung,
        // Membership is checked on the BARE id: the catalog never lists the
        // prefixed form. Flags a rung the gateway no longer offers.
        inCatalog: catalogError ? null : known.has(rung.value),
        /** What actually goes on the wire, for the UI to echo back. */
        resolved: applyPrefix(prefix.value, rung.value),
      })),
    }
  }

  /**
   * Pin the ladder and prefix. Model ids are validated against the live
   * catalog, so a typo can't take chat down; if the catalog is unreachable we
   * refuse rather than persist something we can't check.
   *
   * The prefix is NOT checked against the catalog — it's a routing namespace
   * the catalog knows nothing about — only that it's a well-formed segment.
   */
  @Put('/')
  async put(@Req() req: Request, @Body() body: PutConfigBody) {
    const ladder = {} as OpencodeLadder
    for (const rung of LADDER_RUNGS) {
      const value = body[rung]?.trim()
      if (!value) throw new BadRequestException(`${rung} is required`)
      ladder[rung] = value
    }

    const prefix = normalizePrefix(body.prefix)
    if (prefix && !PREFIX_RE.test(prefix)) {
      throw new BadRequestException(
        `prefix "${prefix}" is not a valid path segment. Use something like "opencode-go", ` +
          `or leave it empty to send bare model ids.`,
      )
    }

    let models: OpencodeModel[]
    try {
      models = await fetchOpencodeModels(this.config)
    } catch (err) {
      if (!(err instanceof OpencodeCatalogError)) throw err
      throw new BadGatewayException(
        `Cannot validate models against the OpenCode catalog right now: ${err.message}`,
      )
    }

    const known = new Set(models.map((m) => m.id))
    const unknown = LADDER_RUNGS.filter((r) => !known.has(ladder[r])).map(
      (r) => `${r}="${ladder[r]}"`,
    )
    if (unknown.length) {
      throw new BadRequestException(
        `Not offered by the OpenCode gateway: ${unknown.join(', ')}. ` +
          `Pick bare ids from the catalog (e.g. "glm-5.2") — the prefix is set separately.`,
      )
    }

    const session = (req as Request & { session: Session }).session
    await this.settings.setOpencodeConfig({ ladder, prefix }, session.username ?? null)
    return this.settings.opencodeDetail()
  }

  /** Drop the overrides; ladder and prefix fall back to the env vars. */
  @Post('reset')
  async reset() {
    await this.settings.resetOpencodeConfig()
    return this.settings.opencodeDetail()
  }
}
