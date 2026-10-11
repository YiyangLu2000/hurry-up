/**
 * Walking and driving routes from the FOSSGIS OSRM service at
 * routing.openstreetmap.de (free, keyless, OpenStreetMap data).
 *
 * Usage policy (https://routing.openstreetmap.de/about.html): show
 * attribution and a "fix the map" link, send a valid user agent and referrer,
 * at most one request per second, no scraping or heavy use. Browsers send
 * their own user agent and the app's origin as the referrer; requests here
 * are one per selection or travel-mode change, cached for the session, and
 * spaced at least a second apart. The auto-select comparison adds one table
 * (matrix) request per page load: one origin to at most six restrooms.
 */

import type { TravelMode } from './directions'
import type { Point } from './location'

const BASE: Record<TravelMode, string> = {
  walk: 'https://routing.openstreetmap.de/routed-foot',
  drive: 'https://routing.openstreetmap.de/routed-car',
}
export const ROUTE_TIMEOUT_MS = 8000
const MIN_REQUEST_GAP_MS = 1000

export const ROUTING_ATTRIBUTION =
  'Routing <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener">FOSSGIS OSRM</a>' +
  ' · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Fix the map</a>'

/** [longitude, latitude] pairs, as GeoJSON wants them. */
export type LineCoords = [number, number][]

export type Route = {
  kind: 'route'
  coordinates: LineCoords
  /** Meters along the route. */
  distance: number
  /** Seconds, as estimated by the routing profile. */
  duration: number
}

const cache = new Map<string, Route>()
let lastRequestAt = 0

const fixed = (p: Point) => `${p.longitude.toFixed(5)},${p.latitude.toFixed(5)}`

/** Same mode and endpoints (to about a meter) share one cached route. */
export function routeKey(mode: TravelMode, from: Point, to: Point): string {
  return `${mode}:${fixed(from)};${fixed(to)}`
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

/**
 * The route, or null when the service fails, answers without a route, or
 * takes longer than ROUTE_TIMEOUT_MS. Rejects only when `signal` aborts
 * (the caller moved on). Failures are not cached, so a later attempt retries.
 */
export async function fetchRoute(
  mode: TravelMode,
  from: Point,
  to: Point,
  signal: AbortSignal,
): Promise<Route | null> {
  const key = routeKey(mode, from, to)
  const cached = cache.get(key)
  if (cached) return cached

  const gap = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
  if (gap > 0) await wait(gap, signal)
  lastRequestAt = Date.now()

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('route timeout')), ROUTE_TIMEOUT_MS)
  const onAbort = () => timeout.abort(signal.reason)
  signal.addEventListener('abort', onAbort)
  try {
    const url = `${BASE[mode]}/route/v1/driving/${fixed(from)};${fixed(to)}?overview=full&geometries=geojson&alternatives=false&steps=false`
    const res = await fetch(url, { signal: timeout.signal })
    if (!res.ok) return null
    const body = (await res.json()) as {
      code?: string
      routes?: { distance: number; duration: number; geometry: { coordinates: LineCoords } }[]
    }
    const first = body.code === 'Ok' ? body.routes?.[0] : undefined
    if (!first || first.geometry.coordinates.length < 2) return null
    const route: Route = {
      kind: 'route',
      coordinates: first.geometry.coordinates,
      distance: first.distance,
      duration: first.duration,
    }
    cache.set(key, route)
    return route
  } catch (err) {
    if (signal.aborted) throw err
    return null // Network failure or timeout: the caller draws a straight line.
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** "6 min", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** Walking duration (s) and distance (m) from the table service, per destination. */
export type WalkLeg = { duration: number; distance: number } | null

/**
 * Walking duration and distance from `from` to each of `to`, in one table
 * request. Resolves null on failure, an error answer, or after `timeoutMs`
 * (which includes the one-second request spacing); rejects only if `signal`
 * aborts.
 */
export async function fetchWalkingTable(
  from: Point,
  to: Point[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<WalkLeg[] | null> {
  if (to.length === 0) return []
  const deadline = Date.now() + timeoutMs
  const gap = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
  if (gap > 0) {
    if (Date.now() + gap >= deadline) return null
    await wait(gap, signal)
  }
  lastRequestAt = Date.now()

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new Error('table timeout')), Math.max(0, deadline - Date.now()))
  const onAbort = () => timeout.abort(signal.reason)
  signal.addEventListener('abort', onAbort)
  try {
    const coords = [from, ...to].map(fixed).join(';')
    const destinations = to.map((_, i) => i + 1).join(';')
    const url = `${BASE.walk}/table/v1/driving/${coords}?sources=0&destinations=${destinations}&annotations=duration,distance`
    const res = await fetch(url, { signal: timeout.signal })
    if (!res.ok) return null
    const body = (await res.json()) as {
      code?: string
      durations?: (number | null)[][]
      distances?: (number | null)[][]
    }
    const durations = body.code === 'Ok' ? body.durations?.[0] : undefined
    const distances = body.distances?.[0]
    if (!durations || durations.length !== to.length) return null
    return durations.map((d, i) => {
      const m = distances?.[i]
      return typeof d === 'number' && typeof m === 'number' ? { duration: d, distance: m } : null
    })
  } catch (err) {
    if (signal.aborted) throw err
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Which candidate to auto-select, as an index into the candidates, which are
 * in straight-line order (nearest first); `legs` are their walking legs, or
 * null when the comparison failed. The shortest walking duration wins (ties keep straight-line order);
 * with no usable durations, the straight-line nearest (index 0) wins.
 */
export function chooseByWalkingTime(candidateCount: number, legs: WalkLeg[] | null): number {
  let best = 0
  let bestDuration = Infinity
  for (let i = 0; i < candidateCount; i++) {
    const d = legs?.[i]?.duration
    if (typeof d === 'number' && d < bestDuration) {
      bestDuration = d
      best = i
    }
  }
  return best
}
