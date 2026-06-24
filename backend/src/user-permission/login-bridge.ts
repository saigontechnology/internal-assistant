import { OnModuleInit } from '@nestjs/common'
import { LoginEventBus } from '../auth/login-event-bus.js'
import { EffectiveProfileService } from './effective-profile.service.js'

/**
 * Wires the `LoginEventBus` (in AuthModule) to `EffectiveProfileService` (in
 * UserPermissionModule). Triggering the side effects inside the bus listener
 * means the per-profile scan kicks off the moment login completes, NOT on the
 * user's first chat. EffectiveProfileService.resolve() is idempotent — running
 * it on login is no different from running it on the first authenticated
 * request, just earlier.
 */
export class LoginBridge implements OnModuleInit {
  constructor(
    private readonly bus: LoginEventBus,
    private readonly effective: EffectiveProfileService,
  ) {}

  onModuleInit(): void {
    this.bus.on(async (session) => {
      await this.effective.resolve(session)
    })
  }
}
