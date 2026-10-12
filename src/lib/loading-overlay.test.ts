import { describe, expect, it } from 'vitest'
import { OVERLAY_CAP_MS, overlayDone, type OverlayInputs } from './loading-overlay'

const ready: OverlayInputs = {
  mapReady: true,
  cellsReady: true,
  hasLocation: true,
  locationPending: false,
  picked: true,
  selected: true,
  routeDrawn: true,
  nothingNearby: false,
}

describe('overlayDone', () => {
  it('closes once map, cells, pick and route are all done', () => {
    expect(overlayDone(ready)).toBe(true)
  })

  it('waits for the map, the cells in view, and the route of the pick', () => {
    expect(overlayDone({ ...ready, mapReady: false })).toBe(false)
    expect(overlayDone({ ...ready, cellsReady: false })).toBe(false)
    expect(overlayDone({ ...ready, routeDrawn: false })).toBe(false)
    expect(overlayDone({ ...ready, picked: false })).toBe(false)
  })

  it('does not wait when nothing is within range, or the pick chose nothing', () => {
    expect(overlayDone({ ...ready, picked: false, selected: false, nothingNearby: true })).toBe(true)
    expect(overlayDone({ ...ready, selected: false, routeDrawn: false })).toBe(true)
  })

  it('without a location: waits only while the browser is still being asked', () => {
    const noLocation = { ...ready, hasLocation: false, picked: false, selected: false, routeDrawn: false }
    expect(overlayDone({ ...noLocation, locationPending: true })).toBe(false)
    expect(overlayDone({ ...noLocation, locationPending: false })).toBe(true)
  })

  it('is capped at 5 s for the first load and 3 s for a re-pick', () => {
    expect(OVERLAY_CAP_MS).toEqual({ initial: 5000, repick: 3000 })
  })
})
