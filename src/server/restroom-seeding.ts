/**
 * Live seeding of one grid cell from Overpass — the fallback for areas the
 * bulk import has not covered. Kept apart from the HTTP route so it can be
 * unit-tested with fake record tools and a stubbed fetch.
 *
 * Per cell, `restroom_areas` (record id = cellKey) decides whether Overpass
 * is asked at all:
 * - `coveredBy: 'import'` — the bulk import saved this cell's restrooms; never
 *   ask Overpass again (no expiry);
 * - otherwise a live fetch younger than 7 days is fresh; older or missing
 *   fetches go to Overpass.
 */

import type { ActionTools } from 'deepspace/worker'
import type { Cell } from '../lib/us-geo.js'
import { toRestroom, type OverpassElement } from '../lib/osm-restrooms.js'
import { saveNewRestrooms } from './restroom-writes.js'

const CELL_TTL_SECONDS = 7 * 24 * 60 * 60
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

export type SeedResult =
  | { status: 'covered' }
  | { status: 'fresh'; fetchedAt: number }
  | { status: 'seeded'; found: number; created: number }

/** Every Overpass endpoint failed; the client should back off and retry. */
export class OverpassUnavailableError extends Error {}

type AreaData = { fetchedAt?: number; coveredBy?: string }

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

/** Seed one cell with `tools` (RBAC-bypassing, as the seeder identity). */
export async function seedCell(tools: ActionTools, cell: Cell, now: number): Promise<SeedResult> {
  const area = await tools.get('restroom_areas', cell.key)
  if (area.success) {
    const data = (area.data as { record: { data: AreaData } }).record.data
    if (data.coveredBy === 'import') return { status: 'covered' }
    const fetchedAt = data.fetchedAt ?? 0
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
