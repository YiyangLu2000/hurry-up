/**
 * Server-side scores and visibility. Everything here runs with the
 * RBAC-bypassing record tools (see action-routes.ts), so callers must have
 * authorized the request before calling in.
 *
 * - `scoreForNewRestroom`: the summary and visibility a restroom is created with.
 * - `recomputeRestroom`: rebuilds one restroom's summary from its ratings and
 *   its visibility from status + score, safely under concurrent writers.
 * - `backfillCell`: sets sample scores and visibility for one grid cell.
 */

import type { ActionTools } from 'deepspace/worker'
import { cellForPoint } from '../lib/us-geo.js'
import { effectiveScore, sampleScore, visibilityFor, type Visibility } from '../lib/scores.js'
import type { RestroomRating, RestroomScore } from '../schemas/ratings-schema.js'
import type { Restroom } from '../schemas/restrooms-schema.js'

/** Rounds of recompute-then-verify before giving up (see recomputeRestroom). */
const MAX_ROUNDS = 5

type Row<T> = { recordId: string; data: T }

export function scoreForNewRestroom(recordId: string, row: Restroom): { score: RestroomScore; visibility: Visibility } {
  const sample = sampleScore(recordId)
  return {
    score: { restroomId: recordId, cellKey: row.cellKey, sampleScore: sample, ratingCount: 0, ratingSum: 0, score: sample },
    visibility: visibilityFor(row.status, sample),
  }
}

/**
 * The visibility a restroom row stands for. Rows created before ratings have
 * no stored field until the backfill runs; derive theirs from the sample.
 */
export function visibilityOf(row: Row<Restroom>, score?: RestroomScore | null): Visibility {
  return row.data.visibility ?? visibilityFor(row.data.status, score?.score ?? sampleScore(row.recordId))
}

async function getRow<T>(tools: ActionTools, collection: string, id: string): Promise<Row<T> | null> {
  const res = await tools.get(collection, id)
  if (!res.success) return null
  const record = (res.data as { record: Row<T> }).record
  return { recordId: record.recordId ?? id, data: record.data }
}

async function queryRows<T>(tools: ActionTools, collection: string, where: Record<string, unknown>): Promise<Row<T>[]> {
  const res = await tools.query(collection, { where })
  if (!res.success) throw new Error(`query ${collection} failed: ${res.error}`)
  return (res.data as { records: Row<T>[] }).records
}

export async function getRestroom(tools: ActionTools, id: string): Promise<Row<Restroom> | null> {
  return getRow<Restroom>(tools, 'restrooms', id)
}

export async function getScore(tools: ActionTools, id: string): Promise<RestroomScore | null> {
  return (await getRow<RestroomScore>(tools, 'restroom_scores', id))?.data ?? null
}

/** Everything a restroom's summary and visibility are computed from. */
type Inputs = {
  restroom: Row<Restroom>
  ratings: Row<RestroomRating>[]
  stored: RestroomScore | null
  /** Identifies the inputs: equal fingerprints mean nothing changed in between. */
  fingerprint: string
}

async function readInputs(tools: ActionTools, restroomId: string): Promise<Inputs | null> {
  const [restroom, ratings, stored] = await Promise.all([
    getRestroom(tools, restroomId),
    queryRows<RestroomRating>(tools, 'restroom_ratings', { restroomId }),
    getScore(tools, restroomId),
  ])
  if (!restroom) return null
  const fingerprint = [
    restroom.data.status,
    ...ratings.map((r) => `${r.recordId}=${r.data.stars}`).sort(),
  ].join('|')
  return { restroom, ratings, stored, fingerprint }
}

export type Recomputed = { score: number; ratingCount: number; sample: boolean; visibility: Visibility }

/**
 * Rebuild one restroom's summary (`restroom_scores`) from its ratings, and its
 * `visibility` from status + score. Called after every rating and every
 * status change. Returns null when the restroom does not exist.
 *
 * Recompute-then-verify. Each record call is a separate request to the
 * record room, so read → compute → write is NOT atomic, and other worker
 * instances run the same code at the same time. A counter that is
 * incremented would drift; so the summary is never incremented, it is always
 * recomputed from the ratings themselves, and after writing it this function
 * reads the inputs again: if they changed since it computed, it goes round
 * again.
 *
 * Two-user example, on a restroom with no ratings (sample 3.8):
 *   1. Ana's action saves her 5. Ben's action saves his 4.
 *   2. Ana's action reads the ratings, but its read lands between the two
 *      saves, so it sees only [Ana 5]: average 5.0, premium.
 *   3. Ben's action reads [Ana 5, Ben 4]: average 4.5, writes it, re-reads
 *      [Ana 5, Ben 4] — unchanged, so Ben's action is done.
 *   4. Ana's action, slower, now writes its stale 5.0 over Ben's 4.5.
 *   5. Ana's action re-reads the ratings: [Ana 5, Ben 4]. That differs from
 *      the [Ana 5] it computed from, so it goes round again, computes 4.5
 *      and writes it. Its next re-read matches, so it stops. Final: 4.5.
 *
 * Why the final state is always right: look at the LAST write of a summary.
 * Its writer re-read the inputs after that write and found them unchanged,
 * so it was computed from the inputs as they were then. A rating saved
 * after that re-read belongs to an action that writes a summary of its own
 * afterwards — which would make that one the last write. So no change is
 * ever left out of the final summary. The same holds for status changes,
 * which are part of the fingerprint.
 *
 * The one gap is a crash (or MAX_ROUNDS without settling) between saving a
 * rating and writing the summary: it stays stale until the next rating or a
 * re-run of the backfill tool, which recomputes rated restrooms.
 */
export async function recomputeRestroom(tools: ActionTools, restroomId: string): Promise<Recomputed | null> {
  let inputs = await readInputs(tools, restroomId)
  for (let round = 1; inputs; round++) {
    const { restroom, ratings, stored } = inputs
    const sample = stored?.sampleScore ?? sampleScore(restroomId)
    const ratingCount = ratings.length
    const ratingSum = ratings.reduce((sum, r) => sum + r.data.stars, 0)
    const score = effectiveScore(sample, ratingCount, ratingSum)
    const visibility = visibilityFor(restroom.data.status, score)

    const summary: RestroomScore = {
      restroomId,
      cellKey: restroom.data.cellKey || cellForPoint(restroom.data.latitude, restroom.data.longitude).key,
      sampleScore: sample,
      ratingCount,
      ratingSum,
      score,
    }
    // Skipping an unchanged write is safe: a concurrent writer that put
    // something else there re-reads afterwards and corrects it itself.
    if (!stored || stored.ratingCount !== ratingCount || stored.ratingSum !== ratingSum || stored.score !== score) {
      const saved = await tools.create('restroom_scores', { ...summary }, restroomId)
      if (!saved.success) throw new Error(`saving score for ${restroomId} failed: ${saved.error}`)
    }
    if (restroom.data.visibility !== visibility) {
      const saved = await tools.update('restrooms', restroomId, { visibility })
      if (!saved.success) throw new Error(`saving visibility for ${restroomId} failed: ${saved.error}`)
    }

    const after = await readInputs(tools, restroomId)
    if (!after || after.fingerprint === inputs.fingerprint) {
      return { score, ratingCount, sample: ratingCount === 0, visibility }
    }
    if (round >= MAX_ROUNDS) {
      console.warn(`[scores] ${restroomId} still changing after ${MAX_ROUNDS} rounds; left for the next write`)
      return { score, ratingCount, sample: ratingCount === 0, visibility }
    }
    inputs = after
  }
  return null
}

export type BackfillResult = {
  restrooms: number
  alreadySet: number
  recomputed: number
  failed: number
  /** False when the call budget ran out first: call again with the same cells. */
  complete: boolean
}

/**
 * Record calls one row can need in the worst case: a first read of its
 * inputs (3), then per round two writes and a verifying read (5).
 */
const WORST_CASE_CALLS_PER_ROW = 3 + MAX_ROUNDS * 5

/** Counts every record call made through `tools`. */
function countCalls(tools: ActionTools): { tools: ActionTools; used: () => number } {
  let used = 0
  const counted = new Proxy(tools, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        used++
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  })
  return { tools: counted, used: () => used }
}

/**
 * Give every restroom in these cells a summary row and a visibility, using
 * at most `maxCalls` record calls. Each record call is a subrequest, and a
 * Worker invocation may make only so many (Cloudflare refuses the rest with
 * "Too many API requests by single Worker invocation"), so the work stops
 * before a row that might not fit and answers `complete: false`; calling
 * again with the same cells continues, because finished rows are skipped.
 *
 * Re-running is safe: rows whose summary and visibility already agree are
 * skipped without a write, and every other row goes through
 * recomputeRestroom — the only code that writes a summary — so a rating
 * saved while the backfill runs is never overwritten by a bare sample score.
 */
export async function backfillCells(tools: ActionTools, cellKeys: string[], maxCalls: number): Promise<BackfillResult> {
  const counter = countCalls(tools)
  const result: BackfillResult = { restrooms: 0, alreadySet: 0, recomputed: 0, failed: 0, complete: true }

  for (const cellKey of cellKeys) {
    if (counter.used() + 2 > maxCalls) return { ...result, complete: false }
    const [restrooms, scores] = await Promise.all([
      queryRows<Restroom>(counter.tools, 'restrooms', { cellKey }),
      queryRows<RestroomScore>(counter.tools, 'restroom_scores', { cellKey }),
    ])
    const byId = new Map(scores.map((s) => [s.recordId, s.data]))
    result.restrooms += restrooms.length

    for (const row of restrooms) {
      const stored = byId.get(row.recordId)
      const settled =
        stored &&
        stored.ratingCount === 0 &&
        stored.sampleScore === sampleScore(row.recordId) &&
        stored.score === stored.sampleScore &&
        row.data.visibility === visibilityFor(row.data.status, stored.score)
      if (settled) {
        result.alreadySet++
        continue
      }
      if (counter.used() + WORST_CASE_CALLS_PER_ROW > maxCalls) return { ...result, complete: false }
      try {
        await recomputeRestroom(counter.tools, row.recordId)
        result.recomputed++
      } catch (err) {
        result.failed++
        console.warn(`[scores] backfill ${row.recordId} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return result
}
