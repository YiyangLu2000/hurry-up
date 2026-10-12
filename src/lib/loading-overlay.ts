/**
 * When the blocking loading overlay may close.
 *
 * It covers the first load (and a re-pick after "Recenter on me" or a new
 * typed location) until the map is ready, the restrooms for the cells in
 * view have loaded, and the closest-restroom pick has settled with its route
 * drawn. It never waits on live seeding (Overpass), and a hard cap closes it
 * regardless (see OVERLAY_CAP_MS).
 */

export type OverlayKind = 'initial' | 'repick'

/** The overlay never stays longer than this, whatever is still pending. */
export const OVERLAY_CAP_MS: Record<OverlayKind, number> = { initial: 5000, repick: 3000 }

export type OverlayInputs = {
  mapReady: boolean
  /** Every subscribed cell in view has its restrooms (or none are needed, e.g. zoomed out). */
  cellsReady: boolean
  /** The visitor's location is known (GPS or set by hand). */
  hasLocation: boolean
  /** The browser is still being asked for the location (its prompt may be open). */
  locationPending: boolean
  /** The closest-restroom pick has run for the current location. */
  picked: boolean
  /** A restroom is selected… */
  selected: boolean
  /** …and its route (or straight-line fallback) from the current location is drawn. */
  routeDrawn: boolean
  /** No restroom matching the filters is within auto-select range. */
  nothingNearby: boolean
}

export function overlayDone(i: OverlayInputs): boolean {
  if (!i.mapReady || !i.cellsReady) return false
  if (!i.hasLocation) return !i.locationPending // no location: nothing to pick once the browser answered
  if (i.picked) return !i.selected || i.routeDrawn
  // Not picked yet: an empty area does not hold the visitor (the pick keeps
  // watching in the background). The pick never waits on live seeding.
  return i.nothingNearby
}
