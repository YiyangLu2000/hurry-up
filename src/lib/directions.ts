/**
 * Directions links and straight-line distance for the restroom details panel.
 *
 * Without `from`, a link carries only the destination, so the maps app routes
 * from the device's current location. With `from` (a location the visitor
 * set themselves), the route starts there instead. Only https links are
 * used: an app scheme such as comgooglemaps:// fails outright when the app
 * is not installed.
 */

export type MapsProvider = 'apple' | 'google'
export type TravelMode = 'walk' | 'drive'

type Point = { latitude: number; longitude: number }

const coord = (p: Point) => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`

export function directionsUrl(provider: MapsProvider, mode: TravelMode, to: Point, from?: Point | null): string {
  if (provider === 'apple') {
    const start = from ? `saddr=${coord(from)}&` : ''
    return `https://maps.apple.com/?${start}daddr=${coord(to)}&dirflg=${mode === 'walk' ? 'w' : 'd'}`
  }
  const travelmode = mode === 'walk' ? 'walking' : 'driving'
  const start = from ? `&origin=${coord(from)}` : ''
  return `https://www.google.com/maps/dir/?api=1${start}&destination=${coord(to)}&travelmode=${travelmode}`
}

/** iPhone, iPad (iPadOS reports a Macintosh user agent), and Mac. */
export function isAppleDevice(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(userAgent)
}

const PROVIDER_KEY = 'hurry-up:maps-provider'

/** The remembered choice; storage may be unavailable (private mode, blocked). */
export function loadMapsProvider(): MapsProvider | null {
  try {
    const value = localStorage.getItem(PROVIDER_KEY)
    return value === 'apple' || value === 'google' ? value : null
  } catch {
    return null
  }
}

export function saveMapsProvider(provider: MapsProvider): void {
  try {
    localStorage.setItem(PROVIDER_KEY, provider)
  } catch {
    // Not persisted; the choice still applies for this page view.
  }
}

/** Great-circle distance in meters. */
export function distanceMeters(a: Point, b: Point): number {
  const R = 6_371_000
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.latitude - a.latitude)
  const dLng = rad(b.longitude - a.longitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084
const WALK_METERS_PER_MINUTE = 80

/** Feet under a tenth of a mile (to the nearest 10 ft), miles above. */
export function formatDistance(meters: number): string {
  const miles = meters / METERS_PER_MILE
  if (miles < 0.1) return `${Math.max(10, Math.round((meters * FEET_PER_METER) / 10) * 10)} ft`
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`
}

export function walkingMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / WALK_METERS_PER_MINUTE))
}
