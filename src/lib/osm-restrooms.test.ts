import { describe, expect, it } from 'vitest'
import { toRestroom, type OverpassElement } from './osm-restrooms'
import { cellForPoint } from './us-geo'

const LA = { lat: 34.0485, lon: -118.2525 }
const node = (tags: Record<string, string>, extra: Partial<OverpassElement> = {}): OverpassElement => ({
  type: 'node',
  id: 101,
  ...LA,
  tags,
  ...extra,
})

describe('toRestroom', () => {
  it('maps a public toilet with gender, wheelchair, ids and cellKey', () => {
    const row = toRestroom(node({ amenity: 'toilets', unisex: 'yes', wheelchair: 'yes', name: 'Park WC' }))
    expect(row).toEqual({
      recordId: 'osm-node-101',
      data: {
        name: 'Park WC',
        latitude: LA.lat,
        longitude: LA.lon,
        kind: 'public',
        genderType: 'gender-neutral',
        wheelchair: 'yes',
        source: 'osm',
        osmId: 'node/101',
        status: 'active',
        cellKey: cellForPoint(LA.lat, LA.lon).key,
      },
    })
  })

  it('skips toilets closed to the public', () => {
    expect(toRestroom(node({ amenity: 'toilets', access: 'private' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'toilets', access: 'no' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'toilets', access: 'customers' }))).not.toBeNull()
  })

  it('keeps fast food only with a brand, named after the brand when unnamed', () => {
    expect(toRestroom(node({ amenity: 'fast_food' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'fast_food', brand: ' ' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'restaurant', brand: 'Subway' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'fast_food', brand: 'Subway' }))?.data).toMatchObject({
      kind: 'restaurant',
      brand: 'Subway',
      name: 'Subway',
    })
  })

  it('derives gender from male/female tags', () => {
    expect(toRestroom(node({ amenity: 'toilets', male: 'yes' }))?.data.genderType).toBe('men')
    expect(toRestroom(node({ amenity: 'toilets', female: 'yes' }))?.data.genderType).toBe('women')
    expect(toRestroom(node({ amenity: 'toilets', male: 'yes', female: 'yes' }))?.data.genderType).toBe('unknown')
  })

  it('uses the centre of ways and relations', () => {
    const way: OverpassElement = { type: 'way', id: 7, center: LA, tags: { amenity: 'toilets' } }
    expect(toRestroom(way)).toMatchObject({ recordId: 'osm-way-7', data: { osmId: 'way/7' } })
  })

  it('rejects points outside the US (e.g. Tijuana, inside the rough US box)', () => {
    expect(toRestroom(node({ amenity: 'toilets' }, { lat: 32.51, lon: -117.0 }))).toBeNull()
  })

  it('rejects malformed elements instead of inventing ids or positions', () => {
    expect(toRestroom(node({ amenity: 'toilets' }, { lat: undefined }))).toBeNull()
    expect(toRestroom(node({ amenity: 'toilets' }, { id: 0 }))).toBeNull()
    expect(toRestroom({ ...node({ amenity: 'toilets' }), type: 'area' as never })).toBeNull()
  })
})

describe('cafés', () => {
  it('keeps chain cafés (with a brand) as kind "cafe"', () => {
    expect(toRestroom(node({ amenity: 'cafe', brand: 'Starbucks', name: 'Starbucks' }))?.data).toMatchObject({
      kind: 'cafe',
      brand: 'Starbucks',
      name: 'Starbucks',
    })
  })

  it('skips independent cafés (no brand)', () => {
    expect(toRestroom(node({ amenity: 'cafe', name: 'Corner Coffee' }))).toBeNull()
    expect(toRestroom(node({ amenity: 'cafe', brand: '  ' }))).toBeNull()
  })
})
