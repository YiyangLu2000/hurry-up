/**
 * Restroom routes: OpenStreetMap seeding and a local-only status toggle.
 *
 * POST /api/restrooms/seed { cellKey }
 *   Public (signed-out visitors seed too). Fetches one seeding-grid cell from
 *   the Overpass API — its exact bounding box, restricted to the US area — and
 *   creates restrooms it has not seen before. Existing rows are never touched,
 *   so a status set later survives re-seeding. A cell is marked fetched only
 *   after Overpass answered and every new row saved; fresh cells are skipped.
 *
 * POST /api/restrooms/:id/status { status }
 *   Admin-only and only where ALLOW_DEBUG_ROUTES is "true" (deepspace dev).
 *   A testing aid for the visibility rule, not a product feature.
 *
 * Writes go through the RBAC-bypassing record tools as a system identity, so
 * no real user owns a restroom row (which keeps 'published' reads exact).
 */

import type { Hono } from 'hono'
import { resolveAppRole } from 'deepspace/worker'
import type { ActionTools } from 'deepspace/worker'
import { cellFromKey, cellTouchesUS, type Cell } from '../lib/us-geo.js'
import type { GenderType, Restroom, RestroomStatus, Wheelchair } from '../schemas/restrooms-schema.js'
import { createActionTools } from './action-routes.js'
import { resolveAuth } from './http-routes.js'
import type { AppContext, Env } from '../../worker.js'

const SEEDER_USER_ID = 'system:osm-seeder'
const CELL_TTL_SECONDS = 7 * 24 * 60 * 60
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const SAVE_CONCURRENCY = 8

type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

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

function deriveGenderType(tags: Record<string, string>): GenderType {
  if (tags.unisex === 'yes') return 'gender-neutral'
  const male = tags.male === 'yes'
  const female = tags.female === 'yes'
  if (male && !female) return 'men'
  if (female && !male) return 'women'
  return 'unknown'
}

function deriveWheelchair(tags: Record<string, string>): Wheelchair {
  const value = tags['toilets:wheelchair'] ?? tags.wheelchair
  if (value === 'yes' || value === 'designated') return 'yes'
  if (value === 'no') return 'no'
  return 'unknown'
}

/** Maps an Overpass element to a new restroom row; null to skip it. */
function toRestroom(el: OverpassElement): { recordId: string; data: Restroom } | null {
  const tags = el.tags ?? {}
  const latitude = el.lat ?? el.center?.lat
  const longitude = el.lon ?? el.center?.lon
  if (latitude === undefined || longitude === undefined) return null

  const isToilet = tags.amenity === 'toilets'
  if (!isToilet && !tags.brand) return null
  // Toilets explicitly closed to the public are not "public restrooms".
  if (isToilet && (tags.access === 'private' || tags.access === 'no')) return null

  const brand = isToilet ? undefined : tags.brand
  return {
    recordId: `osm-${el.type}-${el.id}`,
    data: {
      name: tags.name ?? brand ?? 'Public restroom',
      latitude,
      longitude,
      kind: isToilet ? 'public' : 'restaurant',
      ...(brand ? { brand } : {}),
      genderType: deriveGenderType(tags),
      wheelchair: deriveWheelchair(tags),
      source: 'osm',
      osmId: `${el.type}/${el.id}`,
      status: 'active',
    },
  }
}

/** Creates rows that do not exist yet. Returns created and failed counts. */
async function saveNew(
  tools: ActionTools,
  rows: { recordId: string; data: Restroom }[],
): Promise<{ created: number; failed: number }> {
  let created = 0
  let failed = 0
  for (let i = 0; i < rows.length; i += SAVE_CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + SAVE_CONCURRENCY).map(async ({ recordId, data }) => {
        // Existence check first: `create` with a known id merges into an
        // existing row, which would overwrite a status set after seeding.
        const existing = await tools.get('restrooms', recordId)
        if (existing.success) return
        const result = await tools.create('restrooms', { ...data }, recordId)
        if (result.success) created++
        else {
          failed++
          console.warn(`[restrooms] create ${recordId} failed: ${result.error}`)
        }
      }),
    )
  }
  return { created, failed }
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
  const { created, failed } = await saveNew(tools, rows)
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

const STATUSES: RestroomStatus[] = ['active', 'unavailable', 'pending']

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

  app.post('/api/restrooms/:id/status', async (c) => {
    if (c.env.ALLOW_DEBUG_ROUTES !== 'true') return c.json({ error: 'not_found' }, 404)
    const auth = await resolveAuth(c.req.raw, c.env)
    if (!auth) return c.json({ error: 'unauthorized' }, 401)
    if ((await resolveAppRole(c.env, auth.userId)) !== 'admin') {
      return c.json({ error: 'forbidden' }, 403)
    }
    const body = await c.req.json<{ status?: unknown }>().catch(() => null)
    const status = body?.status
    if (typeof status !== 'string' || !STATUSES.includes(status as RestroomStatus)) {
      return c.json({ error: 'invalid_status' }, 400)
    }
    console.info(`[restrooms] status ${c.req.param('id')} -> ${status} by ${auth.userId}`)
    const tools = createActionTools(c.env, auth.userId, '')
    const id = c.req.param('id')
    const existing = await tools.get('restrooms', id)
    if (!existing.success) return c.json({ error: 'not_found' }, 404)
    return c.json(await tools.update('restrooms', id, { status }))
  })
}
