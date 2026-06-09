import { SetMetadata } from '@nestjs/common'

/**
 * Marks a route handler (or controller) as unprotected. Read by SessionGuard
 * via Reflector — used for /api/auth/login, /api/auth/callback, /api/health.
 */
export const IS_PUBLIC_KEY = 'isPublic'
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)
