/**
 * Restroom routes: OpenStreetMap live seeding (the fallback for areas not imported).
 *
 * POST /api/restrooms/seed { cellKey }
 *   Public (signed-out visitors seed too). Fetches one seeding-grid cell from
 *   the Overpass API — its exact bounding box, restricted to the US area — and
 *   creates restrooms it has not seen before. Existing rows are never touched,
 *   so a status set later survives re-seeding. A cell is marked fetched only
 *   after Overpass answered and every new row saved; fresh cells and cells
 *   covered by the bulk import are skipped (src/server/restroom-seeding.ts).
 *
 * Status changes go through the admin CLI tool `restrooms_set_status`
 * (src/server/restroom-admin-tools.ts).
 *
 * Writes go through the RBAC-bypassing record tools as a system identity, so
 * no real user owns a restroom row (which keeps 'published' reads exact).
 */

import type { Hono } from 'hono'
import { cellFromKey, cellTouchesUS } from '../lib/us-geo.js'
import { createActionTools } from './action-routes.js'
import { OverpassUnavailableError, seedCell, type SeedResult } from './restroom-seeding.js'
import type { AppContext, Env } from '../../worker.js'

const SEEDER_USER_ID = 'system:osm-seeder'
const RETRY_AFTER_SECONDS = 60

/** Concurrent requests for one cell in this isolate share one fetch. */
const inFlight = new Map<string, Promise<SeedResult>>()

export function registerRestroomRoutes(app: Hono<AppContext>): void {
  app.post('/api/restrooms/seed', async (c) => {
    const body = await c.req.json<{ cellKey?: unknown }>().catch(() => null)
    const cell = typeof body?.cellKey === 'string' ? cellFromKey(body.cellKey) : null
    if (!cell) return c.json({ success: false, error: 'invalid_cell' }, 400)
    if (!cellTouchesUS(cell)) return c.json({ success: false, error: 'outside_us' }, 422)

    let pending = inFlight.get(cell.key)
    if (!pending) {
      const tools = createActionTools(c.env, SEEDER_USER_ID, '')
      pending = seedCell(tools, cell, Math.floor(Date.now() / 1000)).finally(() =>
        inFlight.delete(cell.key),
      )
      inFlight.set(cell.key, pending)
    }
    try {
      return c.json({ success: true, data: await pending })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[restrooms] seeding cell ${cell.key} failed: ${message}`)
      if (err instanceof OverpassUnavailableError) {
        c.header('Retry-After', String(RETRY_AFTER_SECONDS))
        return c.json(
          { success: false, error: 'overpass_unavailable', retryAfterSeconds: RETRY_AFTER_SECONDS },
          502,
        )
      }
      return c.json({ success: false, error: 'save_failed' }, 500)
    }
  })
}
