import { distanceMeters } from './directions'

/**
 * US geography and seeding-grid helpers shared by the worker and the map.
 *
 * The boxes are a cheap first reject only: they overlap slivers of Canada and
 * Mexico, so the Overpass query additionally restricts results to the US area.
 */

type Box = { south: number; west: number; north: number; east: number }

const US_BOXES: Box[] = [
  { south: 24.4, west: -125.0, north: 49.4, east: -66.9 }, // contiguous US
  { south: 51.2, west: -179.2, north: 71.4, east: -129.9 }, // Alaska
  { south: 18.9, west: -160.3, north: 22.3, east: -154.8 }, // Hawaii
]

/** Pan limits for the map: [[west, south], [east, north]]. */
export const US_MAX_BOUNDS: [[number, number], [number, number]] = [
  [-179.9, 17.5],
  [-64.5, 71.6],
]

/** Fallback when location is denied or outside the US: Los Angeles. */
export const DEFAULT_CENTER = { latitude: 34.0522, longitude: -118.2437 }

export function isInUS(latitude: number, longitude: number): boolean {
  return US_BOXES.some(
    (b) => latitude >= b.south && latitude <= b.north && longitude >= b.west && longitude <= b.east,
  )
}

/** Seeding grid: ~2.2 km tall, ~1.8 km wide at mid-US latitudes. */
export const CELL_DEGREES = 0.02

/** Below this zoom the viewport spans too many cells to be worth seeding. */
export const MIN_SEED_ZOOM = 13

/** How far the closest-restroom search reaches (and "Nothing within 5 km"). */
export const SEARCH_RADIUS_METERS = 5000

/** Upper bound on cells the client asks for after one map move. */
export const MAX_SEED_CELLS = 16

export type Cell = { key: string; south: number; west: number; north: number; east: number }

function cellFromIndex(latIndex: number, lngIndex: number): Cell {
  // Round to avoid float drift in the bbox the Overpass query receives.
  const round = (n: number) => Math.round(n * 1e6) / 1e6
  return {
    key: `${latIndex}_${lngIndex}`,
    south: round(latIndex * CELL_DEGREES),
    west: round(lngIndex * CELL_DEGREES),
    north: round((latIndex + 1) * CELL_DEGREES),
    east: round((lngIndex + 1) * CELL_DEGREES),
  }
}

export function cellForPoint(latitude: number, longitude: number): Cell {
  return cellFromIndex(Math.floor(latitude / CELL_DEGREES), Math.floor(longitude / CELL_DEGREES))
}

/** Parse a key produced by `cellForPoint`; null when malformed. */
export function cellFromKey(key: string): Cell | null {
  const match = /^(-?\d{1,5})_(-?\d{1,5})$/.exec(key)
  if (!match) return null
  return cellFromIndex(Number(match[1]), Number(match[2]))
}

/** True when any corner or the center of the cell falls inside a US box. */
export function cellTouchesUS(cell: Cell): boolean {
  const midLat = (cell.south + cell.north) / 2
  const midLng = (cell.west + cell.east) / 2
  return [
    [cell.south, cell.west],
    [cell.south, cell.east],
    [cell.north, cell.west],
    [cell.north, cell.east],
    [midLat, midLng],
  ].some(([lat, lng]) => isInUS(lat, lng))
}

/** Cells covering a viewport, nearest to its center first, capped. */
export function cellsInView(
  bounds: Box,
  center: { latitude: number; longitude: number },
  max = MAX_SEED_CELLS,
): Cell[] {
  const cells: Cell[] = []
  const latStart = Math.floor(bounds.south / CELL_DEGREES)
  const latEnd = Math.floor(bounds.north / CELL_DEGREES)
  const lngStart = Math.floor(bounds.west / CELL_DEGREES)
  const lngEnd = Math.floor(bounds.east / CELL_DEGREES)
  for (let i = latStart; i <= latEnd; i++) {
    for (let j = lngStart; j <= lngEnd; j++) {
      const cell = cellFromIndex(i, j)
      if (cellTouchesUS(cell)) cells.push(cell)
    }
  }
  const distance = (c: Cell) =>
    ((c.south + c.north) / 2 - center.latitude) ** 2 + ((c.west + c.east) / 2 - center.longitude) ** 2
  return cells.sort((a, b) => distance(a) - distance(b)).slice(0, max)
}

/**
 * Cells any part of which lies within `meters` of `center` (US cells only),
 * nearest first. Used to search the whole auto-select range around a
 * location when the restrooms already loaded have nothing in range.
 */
export function cellsWithinRadius(center: { latitude: number; longitude: number }, meters: number): Cell[] {
  const dLat = meters / 111_320
  const dLng = meters / (111_320 * Math.cos((center.latitude * Math.PI) / 180))
  const out: { cell: Cell; d: number }[] = []
  for (let i = Math.floor((center.latitude - dLat) / CELL_DEGREES); i <= Math.floor((center.latitude + dLat) / CELL_DEGREES); i++) {
    for (let j = Math.floor((center.longitude - dLng) / CELL_DEGREES); j <= Math.floor((center.longitude + dLng) / CELL_DEGREES); j++) {
      const cell = cellFromIndex(i, j)
      // Distance to the cell's nearest point (the centre itself if inside).
      const nearest = {
        latitude: Math.min(Math.max(center.latitude, cell.south), cell.north),
        longitude: Math.min(Math.max(center.longitude, cell.west), cell.east),
      }
      const d = distanceMeters(center, nearest)
      if (d <= meters && cellTouchesUS(cell)) out.push({ cell, d })
    }
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.cell)
}
