/**
 * rateRestroom({ restroomId, stars }) — the only way a rating is written.
 *
 * Runs with the RBAC-bypassing record tools, so it authorizes everything
 * itself: whole stars 1 to 5, and a restroom that exists, is active and is
 * visible to the caller (public, or premium for members). A restroom the
 * caller cannot see answers `not_found`, the same as one that does not exist.
 *
 * One rating per user per restroom: the record id is restroomId~userId, so
 * rating again replaces the earlier stars. Then the summary and visibility
 * are recomputed (recomputeRestroom explains how concurrent ratings stay
 * correct).
 *
 * The answer never carries a premium score to a caller without membership:
 * when this rating made the restroom premium for them, they get only
 * `visibleToCaller: false`.
 */

import type { ActionHandler, ActionResult } from 'deepspace/worker'
import { isValidStars } from '../lib/scores.js'
import { ratingRecordId } from '../schemas/ratings-schema.js'
import { canSee, resolveViewer } from '../server/membership.js'
import { getRestroom, getScore, recomputeRestroom, visibilityOf } from '../server/restroom-scores.js'
import type { Env } from '../../worker.js'

export type RateResult =
  | { visibleToCaller: true; stars: number; score: number; ratingCount: number; sample: boolean }
  | { visibleToCaller: false; stars: number }

export const rateRestroom: ActionHandler<Env> = async ({ userId, params, tools, env }): Promise<ActionResult<RateResult>> => {
  const { restroomId, stars } = params
  if (!isValidStars(stars)) return { success: false, error: 'Rating must be a whole number of stars from 1 to 5.' }
  if (typeof restroomId !== 'string' || !restroomId) return { success: false, error: 'Missing restroom.' }

  const [restroom, score, viewer] = await Promise.all([
    getRestroom(tools, restroomId),
    getScore(tools, restroomId),
    resolveViewer(env, userId),
  ])
  if (!restroom || !canSee(viewer, visibilityOf(restroom, score))) {
    return { success: false, error: 'This restroom was not found.' }
  }
  if (restroom.data.status !== 'active') return { success: false, error: 'This restroom cannot be rated right now.' }

  const saved = await tools.create(
    'restroom_ratings',
    { restroomId, userId, stars, updatedAt: Math.floor(Date.now() / 1000) },
    ratingRecordId(restroomId, userId),
  )
  if (!saved.success) return { success: false, error: 'Your rating could not be saved. Please try again.' }

  const result = await recomputeRestroom(tools, restroomId)
  if (!result) return { success: false, error: 'This restroom was not found.' }
  console.info(`[ratings] ${restroomId} rated ${stars} by ${userId}: score=${result.score} count=${result.ratingCount} visibility=${result.visibility}`)
  if (!canSee(viewer, result.visibility)) return { success: true, data: { visibleToCaller: false, stars } }
  return {
    success: true,
    data: { visibleToCaller: true, stars, score: result.score, ratingCount: result.ratingCount, sample: result.sample },
  }
}
