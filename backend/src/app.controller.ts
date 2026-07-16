import { Controller, Get, Inject } from '@nestjs/common'
import { Public } from './auth/public.decorator.js'
import { ActiveStreamRegistry } from './chat/active-stream-registry.js'
import { ChatService } from './chat/chat.service.js'
import { EmbeddingsService } from './embeddings/embeddings.service.js'

@Controller()
export class AppController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(EmbeddingsService) private readonly embeddings: EmbeddingsService,
    @Inject(ActiveStreamRegistry) private readonly streams: ActiveStreamRegistry,
  ) {}

  /**
   * Liveness plus a capacity readout.
   *
   * The `waiting` counts are the useful part: they say whether a slow app is
   * slow because generations are queued behind the concurrency cap, because
   * searches are queued behind the embedding cap, or for some third reason
   * entirely. Under load that distinction is otherwise invisible, and guessing
   * at it is how you end up tuning the wrong number.
   *
   * Public and deliberately cheap — no database call. The container healthcheck
   * polls this, and a health probe that touches the pool would report the
   * server as dead precisely when the pool is saturated, which is the moment
   * you least want it restarted.
   */
  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'internal-assistant',
      capacity: {
        chat: this.chat.limiterStats,
        embeddings: this.embeddings.limiterStats,
        activeStreams: this.streams.size,
      },
    }
  }
}
