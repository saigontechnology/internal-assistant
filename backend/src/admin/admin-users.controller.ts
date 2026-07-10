import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Session } from '@prisma/client'
import { AdminGuard } from '../auth/admin.guard.js'
import { AdminUsersService } from './admin-users.service.js'

interface PatchUserBody {
  role?: 'admin' | 'user'
  isActive?: boolean
  isAllowedToSync?: boolean
  jobTitle?: string
  department?: string
  clearProfileOverride?: boolean
}

/** `/api/admin/users` — user management. Admin-only. */
@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(@Inject(AdminUsersService) private readonly users: AdminUsersService) {}

  @Get('/')
  async list() {
    return { users: await this.users.list() }
  }

  /**
   * Partial update. Every field is optional and applied independently, so the
   * UI can send just the toggle the admin flipped.
   */
  @Patch(':email')
  async patch(
    @Req() req: Request,
    @Param('email') email: string,
    @Body() body: PatchUserBody,
  ) {
    const target = decodeURIComponent(email)
    const caller = (req as Request & { session: Session }).session.username ?? ''
    const isSelf = caller.toLocaleLowerCase() === target.toLocaleLowerCase()

    // Self-lockout guards. An admin who demotes or deactivates themselves
    // would need a DB edit to get back in.
    if (isSelf && body.role === 'user') {
      throw new BadRequestException('You cannot remove your own admin role')
    }
    if (isSelf && body.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account')
    }

    const existing = (await this.users.list()).find((u) => u.email === target)
    if (!existing) throw new NotFoundException(`No such user: ${target}`)

    const hasJobTitle = body.jobTitle !== undefined
    const hasDepartment = body.department !== undefined
    if (hasJobTitle !== hasDepartment) {
      throw new BadRequestException(
        'jobTitle and department must be set together — they form one access-control tuple',
      )
    }

    if (body.role !== undefined) await this.users.setRole(target, body.role)
    if (body.isAllowedToSync !== undefined) {
      await this.users.setSyncAccess(target, body.isAllowedToSync)
    }
    if (body.clearProfileOverride) await this.users.clearProfileOverride(target)
    if (hasJobTitle && hasDepartment) {
      await this.users.setProfile(target, body.jobTitle!, body.department!)
    }
    // Applied last: deactivation drops the user's sessions, and we want the
    // other writes to have landed first.
    if (body.isActive !== undefined) await this.users.setActive(target, body.isActive)

    return { users: await this.users.list() }
  }

  /**
   * Marks the profile stale. The scan runs on the *target user's* next
   * authenticated request, because it needs their delegated Graph token.
   */
  @Post(':email/resync')
  async resync(@Param('email') email: string) {
    const target = decodeURIComponent(email)
    const { scheduled } = await this.users.forceResync(target)
    if (!scheduled) throw new NotFoundException(`No such user: ${target}`)
    return {
      scheduled: true,
      message:
        'Profile marked stale. The scan runs on this user’s next sign-in or chat request, ' +
        'using their own SharePoint access.',
    }
  }
}
