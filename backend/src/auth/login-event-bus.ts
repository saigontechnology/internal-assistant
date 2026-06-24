import { EventEmitter } from 'node:events'
import type { Session } from '@prisma/client'

/**
 * Minimal in-process pub/sub for the "user just logged in" event. Exists so
 * UserPermissionModule can kick off the per-profile scan immediately on
 * login (before the user's first chat) without AuthModule taking a dependency
 * on UserPermissionModule — that direction would be a circular import.
 *
 * Listeners must be idempotent and non-throwing (errors are swallowed and
 * logged here so a bad listener can't break the login flow).
 */
export type LoginListener = (session: Session) => void | Promise<void>

export class LoginEventBus {
  private readonly emitter = new EventEmitter()

  on(listener: LoginListener): void {
    this.emitter.on('login', (s: Session) => {
      void (async () => {
        try {
          await listener(s)
        } catch (err) {
          console.warn('[login-event-bus] listener threw:', err)
        }
      })()
    })
  }

  emit(session: Session): void {
    this.emitter.emit('login', session)
  }
}
