/**
 * Restroom routes: OpenStreetMap live seeding (the fallback for areas not imported).
 *
 * POST /api/restrooms/seed { cellKey }
 *   Public (signed-out visitors seed too). Fetches one seeding-grid cell from
 *   the Overpass API — its exact bounding box, restricted to the US area — and
 *   creates restrooms it has not seen before. Existing rows are never touched,
 *   so a status set later survives re-seeding. A cell is marked fetched only
 *   after Overpass answered and every new row saved; fresh cells are skipped.
 *
 * Status changes go through the admin CLI tool `restrooms_set_status`
 * (src/server/restroom-admin-tools.ts).
 *
 * Writes go through the RBAC-bypassing record tools as a system identity, so
 * no real user owns a restroom row (which keeps 'published' reads exact).
 */

import type { Hono } from 'hono'
import { cellFromKey, cellTouchesUS, type Cell } from '../lib/us-geo.js'
import { toRestroom, type OverpassElement } from '../lib/osm-restrooms.js'
import { createActionTools } from './action-routes.js'
import { saveNewRestrooms } from './restroom-writes.js'
import type { AppContext, Env } from '../../worker.js'

const SEEDER_USER_ID = 'system:osm-seeder'
const CELL_TTL_SECONDS = 7 * 24 * 60 * 60
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

type SeedResult =
  | { status: 'fresh'; fetchedAt: number }
  | { status: 'seeded'; found: number; created: number }

/** Every Overpass endpoint failed; the client should back off and retry. */
class OverpassUnavailableError extends Error {}

const RETRY_AFTER_SECONDS = 60

/** Concurrent requests for one cell in this isolate share one fetch. */
const inFlight = new Map<string, Promise<SeedResult>>()

function overpassQuery(cell: Cell): string {
  const bbox = `${cell.south},${cell.west},${cell.north},${cell.east}`
  return `[out:json][timeout:25];
area["ISO3166-1"="US"][admin_level=2]->.us;
(
  nwr["amenity"="toilets"](area.us)(${bbox});
  nwr["amenity"="fast_food"]["brand"](area.us)(${bbox});
);
out center tags;`
}

/** Throws unless some endpoint returned a complete, error-free answer. */
async function fetchOverpass(cell: Cell): Promise<OverpassElement[]> {
  const body = new URLSearchParams({ data: overpassQuery(cell) })
  const errors: string[] = []
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'hurry-up-restroom-finder/0.1 (DeepSpace app)',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        errors.push(`${endpoint} answered ${res.status}`)
        continue
      }
      const json = (await res.json()) as { elements?: OverpassElement[]; remark?: string }
      // Overpass reports query timeouts as a 200 with a `remark`; the element
      // list is then partial, so it must not count as a successful fetch.
      if (json.remark && /error/i.test(json.remark)) {
        errors.push(`${endpoint} remark: ${json.remark}`)
        continue
      }
      if (!Array.isArray(json.elements)) {
        errors.push(`${endpoint} returned no elements array`)
        continue
      }
      return json.elements
    } catch (err) {
      errors.push(`${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new OverpassUnavailableError(errors.join('; '))
}

async function seedCell(env: Env, cell: Cell): Promise<SeedResult> {
  const tools = createActionTools(env, SEEDER_USER_ID, '')
  const now = Math.floor(Date.now() / 1000)

  const area = await tools.get('restroom_areas', cell.key)
  if (area.success) {
    const { record } = area.data as { record: { data: { fetchedAt?: number } } }
    const fetchedAt = record.data.fetchedAt ?? 0
    if (now - fetchedAt < CELL_TTL_SECONDS) return { status: 'fresh', fetchedAt }
  }

  const elements = await fetchOverpass(cell)
  const rows = elements.map(toRestroom).filter((row) => row !== null)
  const { created, failed } = await saveNewRestrooms(tools, rows)
  if (failed > 0) {
    // Leave the cell unmarked so the next visit retries; saves are idempotent.
    throw new Error(`${failed} of ${rows.length} restrooms failed to save`)
  }

  const marked = await tools.create(
    'restroom_areas',
    { cellKey: cell.key, fetchedAt: now, resultCount: rows.length },
    cell.key,
  )
  if (!marked.success) console.warn(`[restrooms] marking cell ${cell.key} failed: ${marked.error}`)

  console.info(`[restrooms] seeded cell ${cell.key}: found=${rows.length} created=${created}`)
  return { status: 'seeded', found: rows.length, created }
}

export function registerRestroomRoutes(app: Hono<AppContext>): void {
  app.post('/api/restrooms/seed', async (c) => {
    const body = await c.req.json<{ cellKey?: unknown }>().catch(() => null)
    const cell = typeof body?.cellKey === 'string' ? cellFromKey(body.cellKey) : null
    if (!cell) return c.json({ success: false, error: 'invalid_cell' }, 400)
    if (!cellTouchesUS(cell)) return c.json({ success: false, error: 'outside_us' }, 422)

    let pending = inFlight.get(cell.key)
    if (!pending) {
      pending = seedCell(c.env, cell).finally(() => inFlight.delete(cell.key))
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
