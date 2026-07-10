import type { Session } from '@prisma/client'
import { RuntimeSettingsService } from '../settings/runtime-settings.service.js'
import { JobProfileService } from './job-profile.service.js'
import { JobProfileSyncService } from './job-profile-sync.service.js'
import {
  UserPermissionService,
  type ProfileTuple,
} from './user-permission.service.js'

export interface EffectiveProfile {
  /** The profile actually used for filtering (after fallback resolution). */
  viewer: ProfileTuple
  /** True when the chat layer should fall back to public-only (no allow-list). */
  publicOnly: boolean
  /** The user's own profile, before fallback. Useful for `/api/user/me`. */
  userProfile: ProfileTuple
  /** True iff the user's profile has ever been scanned. */
  userProfileIndexed: boolean
}

/**
 * Resolve the (jobTitle, department) tuple the chat filter should use for a
 * given user, applying the fallback chain from docs/role-based-access-plan.md §8:
 *
 *   1. User's own profile, if it has been scanned (`lastSync IS NOT NULL`).
 *   2. Otherwise the configured DEFAULT_JOB_TITLE / DEFAULT_DEPARTMENT, if scanned.
 *   3. Otherwise public-only (no allow-list applied — only docs with NULL
 *      sharepoint_code are returned).
 *
 * Side effect: triggers the weekly-resync gate (§4) and a new-profile scan
 * when applicable.
 */
export class EffectiveProfileService {
  constructor(
    private readonly config: RuntimeSettingsService,
    private readonly perms: UserPermissionService,
    private readonly profiles: JobProfileService,
    private readonly sync: JobProfileSyncService,
  ) {}

  async resolve(session: Session): Promise<EffectiveProfile> {
    const email = session.username
    const user = email ? await this.perms.ensure(email) : null
    const userProfile: ProfileTuple = user
      ? { jobTitle: user.jobTitle, department: user.department }
      : { jobTitle: '__unassigned__', department: '__unassigned__' }

    const userRow = await this.profiles.find(userProfile)
    const userProfileIndexed = Boolean(userRow?.lastSync)

    // Side effect 1: cold start — profile we've never seen. Kick off a scan.
    if (!userRow && session.username) {
      void this.sync.kickoffNewProfile(session, userProfile).catch((err) => {
        console.warn('[effective-profile] kickoff failed:', (err as Error).message)
      })
    }

    // Side effect 2: weekly resync evaluation.
    if (userRow) {
      void this.sync.evaluateAndMaybeEnqueue(session, userProfile).catch((err) => {
        console.warn('[effective-profile] evaluate failed:', (err as Error).message)
      })
    }

    if (userProfileIndexed) {
      return { viewer: userProfile, publicOnly: false, userProfile, userProfileIndexed: true }
    }

    // Fall through to the default fallback profile.
    const fallback = this.config.defaultProfile
    const fallbackRow = await this.profiles.find(fallback)
    if (fallbackRow?.lastSync) {
      return { viewer: fallback, publicOnly: false, userProfile, userProfileIndexed: false }
    }

    // Neither indexed yet — public-only.
    return { viewer: userProfile, publicOnly: true, userProfile, userProfileIndexed: false }
  }
}
