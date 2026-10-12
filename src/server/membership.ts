/**
 * Who may see what. The single place that decides membership, so phase 4
 * only has to change `hasMembership`.
 *
 * "Membership" means a paying user (phase 4). It is unrelated to the
 * DeepSpace `member` role, which every signed-in user of the app has.
 */

import { resolveAppRole } from 'deepspace/worker'
import type { Visibility } from '../lib/scores.js'
import type { Env } from '../../worker.js'

export type Viewer = { isAdmin: boolean; hasMembership: boolean }

export const SIGNED_OUT: Viewer = { isAdmin: false, hasMembership: false }

/**
 * Until phase 4, only admins (the app owner) have membership. Phase 4 checks
 * the subscription live here with `requireSubscription`, never a stored role.
 */
export async function hasMembership(env: Env, userId: string): Promise<boolean> {
  return (await resolveAppRole(env, userId)) === 'admin'
}

export async function resolveViewer(env: Env, userId: string | null): Promise<Viewer> {
  if (!userId) return SIGNED_OUT
  const isAdmin = (await resolveAppRole(env, userId)) === 'admin'
  return { isAdmin, hasMembership: isAdmin || (await hasMembership(env, userId)) }
}

/** Mirrors the collection read rule, plus premium for members. */
export function canSee(viewer: Viewer, visibility: Visibility): boolean {
  if (viewer.isAdmin) return true
  if (visibility === 'public') return true
  return visibility === 'premium' && viewer.hasMembership
}
