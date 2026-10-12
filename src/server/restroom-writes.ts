/**
 * The one way restrooms are created on the server (live seeding and the bulk
 * import): create only when the record id is new. An existing row is never
 * touched, so a status set after seeding (e.g. unavailable) always survives
 * a re-seed or re-import.
 *
 * A new restroom is created with its summary row (sample score) and its
 * visibility, so it is never left hidden waiting for the backfill. The
 * summary goes first: a restroom row without one would still show its sample
 * through the scores route, but this order keeps the two in step.
 */

import type { ActionTools } from 'deepspace/worker'
import type { Restroom } from '../schemas/restrooms-schema.js'
import { scoreForNewRestroom } from './restroom-scores.js'

const SAVE_CONCURRENCY = 8

export type SaveResult = { created: number; skipped: number; failed: number }

export async function saveNewRestrooms(
  tools: ActionTools,
  rows: { recordId: string; data: Restroom }[],
): Promise<SaveResult> {
  const result: SaveResult = { created: 0, skipped: 0, failed: 0 }
  for (let i = 0; i < rows.length; i += SAVE_CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + SAVE_CONCURRENCY).map(async ({ recordId, data }) => {
        // Existence check first: `create` with a known id merges into an
        // existing row, which would overwrite its status.
        const existing = await tools.get('restrooms', recordId)
        if (existing.success) {
          result.skipped++
          return
        }
        // Nobody can rate a restroom before it exists, so no ratings to merge.
        const { score, visibility } = scoreForNewRestroom(recordId, data)
        const scored = await tools.create('restroom_scores', { ...score }, recordId)
        if (!scored.success) console.warn(`[restrooms] score for ${recordId} failed: ${scored.error}`)
        const created = await tools.create('restrooms', { ...data, visibility }, recordId)
        if (created.success) result.created++
        else {
          result.failed++
          console.warn(`[restrooms] create ${recordId} failed: ${created.error}`)
        }
      }),
    )
  }
  return result
}
