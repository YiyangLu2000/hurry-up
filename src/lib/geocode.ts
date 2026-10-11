/**
 * Turning typed text into a location: "lat, lng" coordinates directly, or a
 * place search through OpenStreetMap's Nominatim (free, keyless).
 *
 * Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * searches must be triggered by the user — never autocomplete as they type —
 * at most one request per second, with the app identified (the browser sends
 * the app's origin as referrer) and OpenStreetMap attribution shown. Results
 * are cached for the session so a repeated search costs nothing.
 */

import { isInUSOutline } from './us-outline'
import type { Point } from './location'

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search'
const TIMEOUT_MS = 8000
const MIN_REQUEST_GAP_MS = 1000

export const GEOCODER_ATTRIBUTION =
  'Search by <a href="https://nominatim.org" target="_blank" rel="noopener">Nominatim</a>' +
  ' · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'

export type Place = Point & { label: string }

/** "34.05, -118.25" or "34.05 -118.25" → a point; null for anything else. */
export function parseCoordinates(text: string): Point | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text)
  if (!m) return null
  const latitude = Number(m[1])
  const longitude = Number(m[2])
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

const cache = new Map<string, Place[]>()
let lastRequestAt = 0

/**
 * US places matching `query`, best first (at most 5). Throws when the
 * service fails or times out, so the caller can say search is unavailable.
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const cached = cache.get(key)
  if (cached) return cached

  const gap = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now()
  if (gap > 0) await new Promise((r) => setTimeout(r, gap))
  lastRequestAt = Date.now()

  const params = new URLSearchParams({
    q: query.trim(),
    format: 'jsonv2',
    countrycodes: 'us',
    limit: '5',
    'accept-language': 'en',
  })
  const res = await fetch(`${SEARCH_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`search failed: ${res.status}`)
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[]
  const places = rows
    .map((r) => ({ label: r.display_name, latitude: Number(r.lat), longitude: Number(r.lon) }))
    // countrycodes=us already filters; the outline also drops territories
    // outside the map's coverage.
    .filter((p) => Number.isFinite(p.latitude) && isInUSOutline(p.latitude, p.longitude))
  cache.set(key, places)
  return places
}
