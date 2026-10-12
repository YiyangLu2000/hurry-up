/**
 * A route belongs to the origin it was requested from.
 *
 * Whenever the visitor's location (the origin) changes — recenter on the
 * device location, a typed location, a tap on the map — the old route, its
 * destination, and the selection chosen from the old origin are discarded
 * before anything is drawn from the new one. A route is only ever drawn or
 * shown while its origin is still the current one, so a line can never join
 * a new origin to a destination picked from an old one.
 */

import type { Point } from './location'

/** Stable identity of an origin; null when the visitor's location is unknown. */
export function originKeyOf(p: Point | null | undefined): string | null {
  return p ? `${p.latitude},${p.longitude}` : null
}

/** The route if it was requested from `originKey`, otherwise nothing to draw. */
export function routeForOrigin<R extends { originKey: string }>(route: R | null, originKey: string | null): R | null {
  return route && originKey !== null && route.originKey === originKey ? route : null
}

/** A route destination, remembered with the origin it was chosen from. */
export type RouteTarget = { id: string; originKey: string | null }

/**
 * Whether a route may be requested to `target` from `originKey`: only when
 * the destination was chosen from this same origin. This stops a request
 * (or a straight-line fallback) from a new origin to an old destination in
 * the moment before the old destination is discarded.
 */
export function canRouteFrom(target: RouteTarget | null, originKey: string | null): target is RouteTarget {
  return target !== null && originKey !== null && target.originKey === originKey
}

/** What follows a selection: the route target and the selected restroom. */
export type RouteChoice = { originKey: string | null; targetId: string | null; selectedId: string | null }

/**
 * The route choice after the origin becomes `originKey`: unchanged for the
 * same origin; otherwise target and selection are dropped (a new pick from
 * the new origin follows).
 */
export function onOriginChange(prev: RouteChoice, originKey: string | null): RouteChoice {
  if (prev.originKey === originKey) return prev
  return { originKey, targetId: null, selectedId: null }
}

/** The location panel's search box: the only state "Clear location" touches. */
export type LocationText<P> = { query: string; results: P[] | null; message: string | null }

/** "Clear location": empty the text, results and message — nothing else. */
export function clearLocationText<P>(_text: LocationText<P>): LocationText<P> {
  return { query: '', results: null, message: null }
}
