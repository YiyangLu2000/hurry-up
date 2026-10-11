import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRoute, formatDuration, routeKey, ROUTE_TIMEOUT_MS } from './routing'

const from = { latitude: 34.0485, longitude: -118.2525 }
let to = { latitude: 34.0486, longitude: -118.2516 }
// Each test uses a fresh destination so the module cache never leaks between tests.
let n = 0
const freshTo = () => ({ latitude: 34.0486 + ++n * 0.001, longitude: -118.2516 })

const okBody = {
  code: 'Ok',
  routes: [{ distance: 108.8, duration: 87, geometry: { coordinates: [[-118.2525, 34.0485], [-118.2516, 34.0486]] } }],
}

// The module remembers its last request time, so the fake clock must only
// move forward across tests or the one-second spacing would carry over.
let clock = Date.now() + 1_000_000
beforeEach(() => {
  vi.useFakeTimers()
  clock += 100_000
  vi.setSystemTime(clock)
  to = freshTo()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Advances past the one-second request spacing left by earlier tests. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1100)
  return p
}

describe('fetchRoute', () => {
  it('uses the foot or car service and caches the result', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(okBody)))
    vi.stubGlobal('fetch', fetchMock)
    const route = await settle(fetchRoute('walk', from, to, new AbortController().signal))
    expect(route).toMatchObject({ kind: 'route', distance: 108.8, duration: 87 })
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/driving\/-118\.25250,34\.04850;/,
    )
    await fetchRoute('walk', from, to, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call served from cache

    await settle(fetchRoute('drive', from, to, new AbortController().signal))
    expect(String(fetchMock.mock.calls[1][0])).toContain('/routed-car/')
  })

  it('returns null (no throw) when the service fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    expect(await settle(fetchRoute('walk', from, to, new AbortController().signal))).toBeNull()
  })

  it('returns null after the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ),
    )
    const pending = fetchRoute('walk', from, to, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1100 + ROUTE_TIMEOUT_MS)
    expect(await pending).toBeNull()
  })

  it('rejects when the caller aborts, so a stale result is never used', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ),
    )
    const controller = new AbortController()
    const pending = fetchRoute('walk', from, to, controller.signal)
    const assertion = expect(pending).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1100)
    controller.abort()
    await assertion
  })

  it('spaces requests at least one second apart', async () => {
    const times: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        times.push(Date.now())
        return new Response(JSON.stringify(okBody))
      }),
    )
    await settle(fetchRoute('walk', from, to, new AbortController().signal))
    const second = fetchRoute('walk', from, freshTo(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1100)
    await second
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000)
  })
})

describe('helpers', () => {
  it('keys routes by mode and endpoints', () => {
    expect(routeKey('walk', from, to)).not.toBe(routeKey('drive', from, to))
  })

  it('formats durations', () => {
    expect(formatDuration(87)).toBe('1 min')
    expect(formatDuration(6 * 60)).toBe('6 min')
    expect(formatDuration(65 * 60)).toBe('1 h 5 min')
    expect(formatDuration(120 * 60)).toBe('2 h')
  })
})
