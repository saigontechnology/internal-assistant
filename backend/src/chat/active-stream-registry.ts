/**
 * In-process map of streamId → AbortController. Backs POST /api/chat/:id/stop
 * so an explicit stop request can cancel the underlying streamText run
 * (not just the client's HTTP connection).
 *
 * Single-instance only for now: if we scale the backend horizontally, a stop
 * request that lands on instance B can't abort a stream running on instance
 * A. The follow-up is to publish a "stop:<streamId>" message on Redis pub/sub
 * so each instance can check whether it owns the controller. Left out of v1
 * because we're running one Nest process today.
 */
export class ActiveStreamRegistry {
  private readonly controllers = new Map<string, AbortController>()

  register(streamId: string): AbortController {
    const controller = new AbortController()
    this.controllers.set(streamId, controller)
    return controller
  }

  /** Called from onFinish / stream error paths so we don't leak controllers. */
  release(streamId: string): void {
    this.controllers.delete(streamId)
  }

  /** Returns true if this instance owned the stream and aborted it. */
  abort(streamId: string): boolean {
    const controller = this.controllers.get(streamId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(streamId)
    return true
  }
}
