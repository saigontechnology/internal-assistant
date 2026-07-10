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
  ChatSettingsService,
  LADDER_RUNGS,
  type OpencodeLadder,
} from '../chat/chat-settings.service.js'
import { AppConfig } from '../config/app-config.service.js'
import {
  fetchOpencodeModels,
  OpencodeCatalogError,
  type OpencodeModel,
} from '../config/opencode-catalog.js'

interface PutLadderBody {
  primary?: string
  fallback?: string
  secondFallback?: string
}

/**
 * `/api/admin/chat-model` — the OpenCode model picker.
 *
 * Only the OpenCode ladder is editable here. CHAT_PROVIDER itself stays in the
 * env: flipping providers swaps the SDK client that ChatService builds at
 * construction time, so it can't be changed without a restart anyway.
 */
@Controller('admin/chat-model')
@UseGuards(AdminGuard)
export class AdminChatModelController {
  constructor(
    @Inject(ChatSettingsService) private readonly settings: ChatSettingsService,
    @Inject(AppConfig) private readonly config: AppConfig,
  ) {}

  /**
   * Current ladder + the gateway's catalog.
   *
   * A catalog fetch failure is reported in-band (`catalogError`) rather than
   * as a 5xx: the admin should still be able to see what's configured, and
   * which rungs are pinned, when opencode.ai is unreachable.
   */
  @Get('/')
  async get(@Query('refresh') refresh?: string) {
    const ladder = await this.settings.opencodeLadderDetail()

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
      ladder: ladder.map((rung) => ({
        ...rung,
        // The env defaults use a `<provider>/<model>` form the gateway doesn't
        // return. Flag anything absent from the catalog so a mis-set rung is
        // visible instead of only failing at stream time.
        inCatalog: catalogError ? null : known.has(rung.value),
      })),
    }
  }

  /**
   * Pin all three rungs. Every value is validated against the live catalog, so
   * a typo can't take chat down; if the catalog is unreachable we refuse rather
   * than persist something we can't check.
   */
  @Put('/')
  async put(@Req() req: Request, @Body() body: PutLadderBody) {
    const ladder = {} as OpencodeLadder
    for (const rung of LADDER_RUNGS) {
      const value = body[rung]?.trim()
      if (!value) throw new BadRequestException(`${rung} is required`)
      ladder[rung] = value
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
    const unknown = LADDER_RUNGS.filter((r) => !known.has(ladder[r])).map((r) => `${r}="${ladder[r]}"`)
    if (unknown.length) {
      throw new BadRequestException(
        `Not offered by the OpenCode gateway: ${unknown.join(', ')}. ` +
          `Pick from the catalog — ids look like "glm-5.2", not "zai/glm-5.2".`,
      )
    }

    const session = (req as Request & { session: Session }).session
    await this.settings.setOpencodeLadder(ladder, session.username ?? null)
    return { ladder: await this.settings.opencodeLadderDetail() }
  }

  /** Drop the overrides; the ladder falls back to OPENCODE_CHAT_*_MODEL. */
  @Post('reset')
  async reset() {
    await this.settings.resetOpencodeLadder()
    return { ladder: await this.settings.opencodeLadderDetail() }
  }
}
