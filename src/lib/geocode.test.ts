import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseCoordinates, searchPlaces } from './geocode'

describe('parseCoordinates', () => {
  it('reads "lat, lng" and "lat lng"', () => {
    expect(parseCoordinates('34.0485, -118.2525')).toEqual({ latitude: 34.0485, longitude: -118.2525 })
    expect(parseCoordinates(' 40.7 -74 ')).toEqual({ latitude: 40.7, longitude: -74 })
  })

  it('rejects addresses and out-of-range numbers', () => {
    expect(parseCoordinates('800 N Alameda St')).toBeNull()
    expect(parseCoordinates('95, -118')).toBeNull()
    expect(parseCoordinates('34, -200')).toBeNull()
  })
})

describe('searchPlaces', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks Nominatim for US results, drops points outside the US, and caches', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(
        JSON.stringify([
          { display_name: 'Union Station, Los Angeles', lat: '34.0560', lon: '-118.2359' },
          { display_name: 'Somewhere in Tijuana', lat: '32.51', lon: '-117.0' },
        ]),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const places = await searchPlaces('Union Station  Los Angeles')
    expect(places).toEqual([{ label: 'Union Station, Los Angeles', latitude: 34.056, longitude: -118.2359 }])
    const url = new URL(fetchMock.mock.calls[0][0])
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search')
    expect(url.searchParams.get('countrycodes')).toBe('us')
    await searchPlaces('union station los angeles')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the service fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    await expect(searchPlaces('anything at all')).rejects.toThrow()
  })
})
