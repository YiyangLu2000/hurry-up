import { describe, expect, it } from 'vitest'
import { canRouteFrom, clearLocationText, onOriginChange, originKeyOf, routeForOrigin } from './route-origin'

const seattle = { latitude: 47.6505, longitude: -122.3205 } // typed location
const la = { latitude: 34.0485, longitude: -118.2525 } // device location
const route = { originKey: originKeyOf(seattle)!, targetId: 'osm-way-521700454', coordinates: [] as number[][] }

describe('a route is tied to its origin (rule 3)', () => {
  it('is drawn while its origin is current', () => {
    expect(routeForOrigin(route, originKeyOf(seattle))).toBe(route)
  })

  it('is never drawn from a new origin, even before it is discarded', () => {
    expect(routeForOrigin(route, originKeyOf(la))).toBeNull()
    expect(routeForOrigin(route, originKeyOf({ ...seattle, latitude: seattle.latitude + 0.0001 }))).toBeNull()
    expect(routeForOrigin(route, null)).toBeNull()
  })

  it('drops the target and selection when the origin changes', () => {
    const chosen = { originKey: originKeyOf(seattle), targetId: 'osm-way-521700454', selectedId: 'osm-way-521700454' }
    expect(onOriginChange(chosen, originKeyOf(la))).toEqual({ originKey: originKeyOf(la), targetId: null, selectedId: null })
    expect(onOriginChange(chosen, null)).toEqual({ originKey: null, targetId: null, selectedId: null })
  })

  it('never requests a route from a new origin to a destination chosen from an old one', () => {
    const target = { id: 'osm-node-la', originKey: originKeyOf(la) }
    expect(canRouteFrom(target, originKeyOf(la))).toBe(true)
    expect(canRouteFrom(target, originKeyOf(seattle))).toBe(false)
    expect(canRouteFrom(target, null)).toBe(false)
    expect(canRouteFrom(null, originKeyOf(la))).toBe(false)
  })

  it('keeps them when the origin is unchanged', () => {
    const chosen = { originKey: originKeyOf(seattle), targetId: 'a', selectedId: 'a' }
    expect(onOriginChange(chosen, originKeyOf({ ...seattle }))).toBe(chosen)
  })
})

describe('"Clear location" changes nothing but the text', () => {
  it('empties the text, results and message', () => {
    const text = { query: 'Union Station, Los Angeles', results: [{ label: 'Union Station' }], message: 'note' }
    expect(clearLocationText(text)).toEqual({ query: '', results: null, message: null })
  })

  it('returns only the panel text, so it cannot carry a location, route, or selection change', () => {
    const cleared = clearLocationText({ query: 'x', results: null, message: null })
    expect(Object.keys(cleared).sort()).toEqual(['message', 'query', 'results'])
  })
})
