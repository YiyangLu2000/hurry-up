import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'
import { cellFromKey } from '../lib/us-geo'
import { seedCell } from './restroom-seeding'

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
    expect(areas[cell.key]).toMatchObject({ cellKey: cell.key, fetchedAt: NOW, resultCount: 1 })
    expect(areas[cell.key]).not.toHaveProperty('coveredBy')
  })

  it('treats a live fetch as fresh for 7 days, then asks Overpass again', async () => {
    const fetchMock = stubOverpass()
    const fresh = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 6 * DAY } })
    expect((await seedCell(fresh.tools, cell, NOW)).status).toBe('fresh')
    expect(fetchMock).not.toHaveBeenCalled()
    const stale = fakeTools({ [cell.key]: { cellKey: cell.key, fetchedAt: NOW - 8 * DAY } })
    expect((await seedCell(stale.tools, cell, NOW)).status).toBe('seeded')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
