/**
 * Score and premium-restroom routes. Both decide per caller on the server;
 * neither trusts anything the browser says about membership.
 *
 * POST /api/restrooms/scores { ids }
 *   Signed in or not. For each id the caller can see (src/server/membership.ts:
 *   public, premium for members, everything for admins) answers
 *   { score, sample, ratingCount }. Ids the caller cannot see are left out,
 *   exactly like ids that do not exist.
 *
 * POST /api/restrooms/premium { cellKeys }
 *   Signed in, with membership (hasMembership) — 401 / 403 otherwise. Answers
 *   the 'premium' restrooms in those cells, which the collection's read rule
 *   never sends to non-admins. Restroom fields only; no scores.
 */

import type { Hono } from 'hono'
import { sampleScore } from '../lib/scores.js'
import { cellFromKey } from '../lib/us-geo.js'
import type { Restroom } from '../schemas/restrooms-schema.js'
import { createActionTools } from './action-routes.js'
import { resolveAuth } from './http-routes.js'
import { canSee, resolveViewer } from './membership.js'
import { getRestroom, getScore, visibilityOf } from './restroom-scores.js'
import type { AppContext } from '../../worker.js'

/** Reads run as this identity; RBAC is off, the checks here decide. */
const READER_USER_ID = 'system:score-reader'
const MAX_IDS = 50
/** The map keeps at most 64 cells subscribed (RETAINED_CELLS in home.tsx). */
const MAX_CELLS = 64

export type ScoreAnswer = { score: number; sample: boolean; ratingCount: number }

export function registerScoreRoutes(app: Hono<AppContext>): void {
  app.post('/api/restrooms/scores', async (c) => {
    const body = await c.req.json<{ ids?: unknown }>().catch(() => null)
    const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.filter((id): id is string => typeof id === 'string' && !!id))] : null
    if (!ids || ids.length === 0 || ids.length > MAX_IDS) return c.json({ success: false, error: 'invalid_ids' }, 400)

    const auth = await resolveAuth(c.req.raw, c.env)
    const viewer = await resolveViewer(c.env, auth?.userId ?? null)
    const tools = createActionTools(c.env, READER_USER_ID, '')
    const scores: Record<string, ScoreAnswer> = {}
    await Promise.all(
      ids.map(async (id) => {
        const [restroom, score] = await Promise.all([getRestroom(tools, id), getScore(tools, id)])
        if (!restroom || !canSee(viewer, visibilityOf(restroom, score))) return
        // No stored summary yet (a row from before the backfill): its sample.
        scores[id] = score
          ? { score: score.score, sample: score.ratingCount === 0, ratingCount: score.ratingCount }
          : { score: sampleScore(id), sample: true, ratingCount: 0 }
      }),
    )
    return c.json({ success: true, data: { scores } })
  })

  app.post('/api/restrooms/premium', async (c) => {
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ success: false, error: 'unauthorized' }, 401)
    const viewer = await resolveViewer(c.env, auth.userId)
    if (!viewer.hasMembership) return c.json({ success: false, error: 'membership_required' }, 403)

    const body = await c.req.json<{ cellKeys?: unknown }>().catch(() => null)
    const keys = Array.isArray(body?.cellKeys) ? [...new Set(body.cellKeys.filter((k): k is string => typeof k === 'string'))] : null
    if (!keys || keys.length === 0 || keys.length > MAX_CELLS || keys.some((k) => !cellFromKey(k))) {
      return c.json({ success: false, error: 'invalid_cells' }, 400)
    }
    const tools = createActionTools(c.env, READER_USER_ID, '')
    const records: { recordId: string; data: Restroom }[] = []
    await Promise.all(
      keys.map(async (cellKey) => {
        const res = await tools.query<Restroom & Record<string, unknown>>('restrooms', { where: { cellKey, visibility: 'premium' } })
        if (!res.success) throw new Error(`premium query ${cellKey} failed: ${res.error}`)
        for (const r of res.data.records) {
          records.push({ recordId: r.recordId, data: r.data })
        }
      }),
    )
    return c.json({ success: true, data: { records } })
  })
}
