/**
 * OpenStreetMap → restroom rows. The one mapping used by live seeding
 * (src/server/restroom-routes.ts) and the bulk import tool
 * (src/server/restroom-admin-tools.ts), so both apply the same rules:
 * US only, public toilets unless private, fast food only with a brand.
 */

import { normalizeRestroom } from '../schemas/restrooms-schema'
import type { GenderType, Restroom, Wheelchair } from '../schemas/restrooms-schema'
import { cellForPoint } from './us-geo'
import { isInUSOutline } from './us-outline'

/** An element from an Overpass `out center tags` answer. */
export type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

export function deriveGenderType(tags: Record<string, string>): GenderType {
  if (tags.unisex === 'yes') return 'gender-neutral'
  const male = tags.male === 'yes'
  const female = tags.female === 'yes'
  if (male && !female) return 'men'
  if (female && !male) return 'women'
  return 'unknown'
}

export function deriveWheelchair(tags: Record<string, string>): Wheelchair {
  const value = tags['toilets:wheelchair'] ?? tags.wheelchair
  if (value === 'yes' || value === 'designated') return 'yes'
  if (value === 'no') return 'no'
  return 'unknown'
}

/** Maps an Overpass element to a new restroom row; null to skip it. */
export function toRestroom(el: OverpassElement): { recordId: string; data: Restroom } | null {
  const tags = el.tags ?? {}
  const latitude = el.lat ?? el.center?.lat
  const longitude = el.lon ?? el.center?.lon
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return null
  if (el.type !== 'node' && el.type !== 'way' && el.type !== 'relation') return null
  if (!Number.isInteger(el.id) || el.id <= 0) return null
  if (!isInUSOutline(latitude, longitude)) return null

  const isToilet = tags.amenity === 'toilets'
  if (!isToilet && !(tags.amenity === 'fast_food' && tags.brand?.trim())) return null
  // Toilets explicitly closed to the public are not "public restrooms".
  if (isToilet && (tags.access === 'private' || tags.access === 'no')) return null

  const brand = isToilet ? undefined : tags.brand
  return {
    recordId: `osm-${el.type}-${el.id}`,
    data: normalizeRestroom({
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
      cellKey: cellForPoint(latitude, longitude).key,
    }),
  }
}
