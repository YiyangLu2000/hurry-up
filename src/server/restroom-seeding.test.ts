import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { cellFromKey, cellsWithinRadius } from '../lib/us-geo'
import { SEED_RULES_VERSION, seedAround, seedCell } from './restroom-seeding'

const NOW = 1_800_000_000
const DAY = 24 * 60 * 60
const cell = cellFromKey('2382_-6117')! // Seattle, Eastlake

/** In-memory stand-in for the RBAC-bypassing record tools. */
function fakeTools(areas: Record<string, Record<string, unknown>> = {}) {
  const rows: Record<string, Record<string, unknown>> = {}
  const tools = {
    get: vi.fn(async (collection: string, id: string) => {
      const data = collection === 'restroom_areas' ? areas[id] : rows[id]
      return data ? { success: true, data: { record: { recordId: id, data } } } : { success: false, error: 'not found' }
    }),
    create: vi.fn(async (collection: string, data: Record<string, unknown>, id: string) => {
      if (collection === 'restroom_areas') areas[id] = { ...areas[id], ...data }
      else rows[id] = data
      return { success: true, data: { recordId: id } }
    }),
  }
  return { tools: tools as unknown as ActionTools, areas, rows }
}

/** Overpass stub: answers with one public toilet inside the cell. */
function stubOverpass() {
  const fetchMock = vi.fn(async (_url: string) =>
    new Response(
      JSON.stringify({
        elements: [{ type: 'node', id: 42, lat: cell.south + 0.005, lon: cell.west + 0.005, tags: { amenity: 'toilets' } }],
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('seedCell', () => {
  it('makes no Overpass call for a cell covered by the import', async () => {
    const fetchMock = stubOverpass()
    const { tools } = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW, coveredBy: 'import' } })
    expect(await seedCell(tools, cell, NOW)).toEqual({ status: 'covered' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an import cover past 7 days (no expiry)', async () => {
    const fetchMock = stubOverpass()
    const { tools } = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 400 * DAY, coveredBy: 'import' } })
    expect(await seedCell(tools, cell, NOW)).toEqual({ status: 'covered' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still calls Overpass for an uncovered cell, saves rows, then marks it fetched', async () => {
    const fetchMock = stubOverpass()
    const { tools, areas, rows } = fakeTools()
    expect(await seedCell(tools, cell, NOW)).toEqual({ status: 'seeded', found: 1, created: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(Object.keys(rows)).toEqual(['osm-node-42'])
    expect(areas[cell.key]).toMatchObject({ cellKey: cell.key, fetchedAt: NOW, resultCount: 1, rulesVersion: SEED_RULES_VERSION })
    expect(areas[cell.key]).not.toHaveProperty('coveredBy')
  })

  it('treats a live fetch as fresh for 7 days, then asks Overpass again', async () => {
    const fetchMock = stubOverpass()
    const fresh = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 6 * DAY, rulesVersion: SEED_RULES_VERSION } })
    expect((await seedCell(fresh.tools, cell, NOW)).status).toBe('fresh')
    expect(fetchMock).not.toHaveBeenCalled()
    const stale = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 8 * DAY, rulesVersion: SEED_RULES_VERSION } })
    expect((await seedCell(stale.tools, cell, NOW)).status).toBe('seeded')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('rules version (cafés added)', () => {
  it('re-fetches a cell fetched under older rules, even if recent', () => {
    const fetchMock = stubOverpass()
    const { tools } = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 1 * DAY } }) // no rulesVersion: before cafés
    return seedCell(tools, cell, NOW).then((r) => {
      expect(r.status).toBe('seeded')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })

  it('asks Overpass for chain cafés too', async () => {
    const fetchMock = stubOverpass()
    const { tools } = fakeTools()
    await seedCell(tools, cell, NOW)
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(String(init.body)).toContain(encodeURIComponent('nwr["amenity"="cafe"]["brand"]').replace(/%20/g, '+'))
  })
})

describe('seedAround', () => {
  const around = cellsWithinRadius({ latitude: 40.9642503, longitude: -73.1283089 }, 5000)

  it('covers the whole 5 km range around a point', () => {
    expect(around.length).toBeGreaterThan(30)
    expect(around[0].key).toBe('2048_-3657') // the cell of the point comes first
    expect(around.map((c) => c.key)).toEqual(expect.arrayContaining(['2046_-3657', '2045_-3657']))
  })

  it('fetches every stale cell with ONE Overpass request and marks them after saving', async () => {
    const fetchMock = stubOverpass()
    const { tools, areas } = fakeTools()
    const r = await seedAround(tools, around, NOW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r).toMatchObject({ status: 'seeded', cells: around.length, fetched: around.length })
    expect(Object.keys(areas)).toHaveLength(around.length)
    expect(Object.values(areas).every((a) => a.rulesVersion === SEED_RULES_VERSION)).toBe(true)
  })

  it('makes no Overpass call when every cell is covered or fresh', async () => {
    const fetchMock = stubOverpass()
    const marks = Object.fromEntries(
      around.map((c, i) => [
        c.key,
        i % 2 ? { cellKey: c.key, coveredBy: 'import', fetchedAt: 0 } : { cellKey: c.key, fetchedAt: NOW, rulesVersion: SEED_RULES_VERSION },
      ]),
    )
    const { tools } = fakeTools(marks)
    expect(await seedAround(tools, around, NOW)).toEqual({ status: 'fresh', cells: around.length })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
