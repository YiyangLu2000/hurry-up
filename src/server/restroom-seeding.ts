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
/**
 * Version of the mapping rules a live fetch used. Bump it when the rules
 * change (2: chain cafés added) so earlier fetches are re-done.
 */
export const SEED_RULES_VERSION = 2
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

type AreaData = { fetchedAt?: number; coveredBy?: string; rulesVersion?: number }
type Box = { south: number; west: number; north: number; east: number }

function overpassQuery(box: Box): string {
  const bbox = `${box.south},${box.west},${box.north},${box.east}`
  return `[out:json][timeout:25];
area["ISO3166-1"="US"][admin_level=2]->.us;
(
  nwr["amenity"="toilets"](area.us)(${bbox});
  nwr["amenity"="fast_food"]["brand"](area.us)(${bbox});
  nwr["amenity"="cafe"]["brand"](area.us)(${bbox});
);
out center tags;`
}

/** Whether a cell's mark means Overpass need not be asked again. */
function areaState(data: AreaData | null, now: number): 'covered' | 'fresh' | 'stale' {
  if (data?.coveredBy === 'import') return 'covered'
  const fresh = data && now - (data.fetchedAt ?? 0) < CELL_TTL_SECONDS && data.rulesVersion === SEED_RULES_VERSION
  return fresh ? 'fresh' : 'stale'
}

async function readArea(tools: ActionTools, key: string): Promise<AreaData | null> {
  const area = await tools.get('restroom_areas', key)
  return area.success ? (area.data as { record: { data: AreaData } }).record.data : null
}

/** Throws unless some endpoint returned a complete, error-free answer. */
async function fetchOverpass(box: Box): Promise<OverpassElement[]> {
  const body = new URLSearchParams({ data: overpassQuery(box) })
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
  const data = await readArea(tools, cell.key)
  const state = areaState(data, now)
  if (state === 'covered') return { status: 'covered' }
  if (state === 'fresh') return { status: 'fresh', fetchedAt: data?.fetchedAt ?? now }

  const elements = await fetchOverpass(cell)
  const rows = elements.map(toRestroom).filter((row) => row !== null)
  const { created, failed } = await saveNewRestrooms(tools, rows)
  if (failed > 0) {
    // Leave the cell unmarked so the next visit retries; saves are idempotent.
    throw new Error(`${failed} of ${rows.length} restrooms failed to save`)
  }

  const marked = await tools.create(
    'restroom_areas',
    { cellKey: cell.key, fetchedAt: now, resultCount: rows.length, rulesVersion: SEED_RULES_VERSION },
    cell.key,
  )
  if (!marked.success) console.warn(`[restrooms] marking cell ${cell.key} failed: ${marked.error}`)

  console.info(`[restrooms] seeded cell ${cell.key}: found=${rows.length} created=${created}`)
  return { status: 'seeded', found: rows.length, created }
}

export type SeedAroundResult =
  | { status: 'fresh'; cells: number }
  | { status: 'seeded'; cells: number; fetched: number; found: number; created: number }

/**
 * Seed every cell of `cells` that is neither covered by the import nor
 * freshly fetched, with ONE Overpass request over their bounding box (rather
 * than one per cell). Used to search the full auto-select range around a
 * location. Cells are marked fetched only after their rows are saved.
 */
export async function seedAround(tools: ActionTools, cells: Cell[], now: number): Promise<SeedAroundResult> {
  const states = await Promise.all(cells.map(async (c) => areaState(await readArea(tools, c.key), now)))
  const needed = cells.filter((_, i) => states[i] === 'stale')
  if (needed.length === 0) return { status: 'fresh', cells: cells.length }

  const box = {
    south: Math.min(...needed.map((c) => c.south)),
    west: Math.min(...needed.map((c) => c.west)),
    north: Math.max(...needed.map((c) => c.north)),
    east: Math.max(...needed.map((c) => c.east)),
  }
  const elements = await fetchOverpass(box)
  const rows = elements.map(toRestroom).filter((row) => row !== null)
  const { created, failed } = await saveNewRestrooms(tools, rows)
  if (failed > 0) throw new Error(`${failed} of ${rows.length} restrooms failed to save`)

  for (const c of needed) {
    const inCell = rows.filter((r) => r.data.cellKey === c.key).length
    const marked = await tools.create(
      'restroom_areas',
      { cellKey: c.key, fetchedAt: now, resultCount: inCell, rulesVersion: SEED_RULES_VERSION },
      c.key,
    )
    if (!marked.success) console.warn(`[restrooms] marking cell ${c.key} failed: ${marked.error}`)
  }
  console.info(`[restrooms] seeded around: cells=${cells.length} fetched=${needed.length} found=${rows.length} created=${created}`)
  return { status: 'seeded', cells: cells.length, fetched: needed.length, found: rows.length, created }
}
