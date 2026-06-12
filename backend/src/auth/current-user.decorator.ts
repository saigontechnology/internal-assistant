import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'

/**
 * Pull the authenticated session off the request — populated by SessionGuard.
 * Throws nothing: if the route is `@Public()`, callers will get `undefined`
 * and should handle that explicitly.
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): Session | undefined => {
  const req = ctx.switchToHttp().getRequest<Request & { session?: Session }>()
  return req.session
})
