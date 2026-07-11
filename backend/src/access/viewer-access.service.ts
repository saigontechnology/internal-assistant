import type { Session } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import {
  UserPermissionService,
  type ProfileTuple,
} from '../user-permission/user-permission.service.js'

export interface ViewerAccess {
  /** The (jobTitle, department) tuple to filter by after fallback resolution. */
  viewer: ProfileTuple
  /** True when there is no allow-list to apply — only public (NULL-code) docs. */
  publicOnly: boolean
}

/**
 * Side-effect-free counterpart to EffectiveProfileService.resolve(), for the
 * READ endpoints that list documents / distribution lists (the sidebar).
 *
 * It applies the SAME fallback chain — own profile → configured default
 * profile → public-only — so the sidebar shows exactly what chat retrieval can
 * reach, but WITHOUT EffectiveProfileService's side effects (kicking off scans
 * / weekly resync). Those belong on the chat path, not on every list refresh.
 *
 * It lives in its own tiny module (no dependency on JobProfileSyncService /
 * DocumentsService) specifically to avoid the module cycle that injecting
 * EffectiveProfileService into DocumentsModule / SharepointListModule would
 * create — UserPermissionModule already imports both of those.
 *
 * INVARIANT: keep this resolution in lockstep with EffectiveProfileService.
 */
export class ViewerAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly perms: UserPermissionService,
    private readonly config: RuntimeSettingsService,
  ) {}

  async resolve(session: Session): Promise<ViewerAccess> {
    const email = session.username
    const user = email ? await this.perms.ensure(email) : null
    const userProfile: ProfileTuple = user
      ? { jobTitle: user.jobTitle, department: user.department }
      : { jobTitle: '__unassigned__', department: '__unassigned__' }

    if (await this.isScanned(userProfile)) {
      return { viewer: userProfile, publicOnly: false }
    }

    const fallback = this.config.defaultProfile
    if (await this.isScanned(fallback)) {
      return { viewer: fallback, publicOnly: false }
    }

    // Nothing scanned yet — most restrictive: public docs only.
    return { viewer: userProfile, publicOnly: true }
  }

  /** True iff this profile's allow-list has ever been built (`last_sync` set). */
  private async isScanned(p: ProfileTuple): Promise<boolean> {
    const row = await this.prisma.jobProfile.findFirst({
      where: { jobTitle: p.jobTitle, department: p.department },
      select: { lastSync: true },
    })
    return Boolean(row?.lastSync)
  }
}
