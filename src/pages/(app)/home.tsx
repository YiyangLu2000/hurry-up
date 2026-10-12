/**
 * Home — full-screen map of nearby restrooms.
 *
 * Restrooms come from the `restrooms` collection, loaded per grid cell in view
 * (RestroomCells: one `useQuery` per cell, `where: { cellKey }`); the server only
 * ships rows the caller may read (active ones, for everyone but admins). The
 * map asks /api/restrooms/seed to fill in OpenStreetMap data for the grid
 * cells in view whenever it settles at a useful zoom.
 *
 * The visitor's location is GPS (when allowed) or a point they set on the map;
 * either one drives the user dot, distances, and the closest-restroom pick.
 *
 * Selecting a restroom requests a walking or driving route to it. The route to
 * the last selected restroom stays on the map after its panel closes, until
 * another restroom is selected or the route is cleared (memory only).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  Marker as MapLibreMarker,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useAuthProfileReady } from 'deepspace'
import { Accessibility, Car, Footprints, Info, Loader2, MapPin, Route as RouteIcon, Utensils, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LocationControl } from '../../components/LocationControl'
import { RestroomCells, type CellRecords } from '../../components/RestroomCells'
import {
  directionsUrl,
  distanceMeters,
  formatDistance,
  isAppleDevice,
  loadMapsProvider,
  saveMapsProvider,
  walkingMinutes,
  type MapsProvider,
  type TravelMode,
} from '../../lib/directions'
import {
  chooseByWalkingTime,
  fetchRoute,
  fetchWalkingTable,
  formatDuration,
  routeKey,
  ROUTING_ATTRIBUTION,
  type LineCoords,
  type Route,
  type WalkLeg,
} from '../../lib/routing'
import {
  cellForPoint,
  cellsInView,
  DEFAULT_CENTER,
  MIN_SEED_ZOOM,
  US_MAX_BOUNDS,
} from '../../lib/us-geo'
import type { ManualLocation, Point } from '../../lib/location'
import { isInUSOutline } from '../../lib/us-outline'
import { OVERLAY_CAP_MS, overlayDone, type OverlayKind } from '../../lib/loading-overlay'
import {
  canRouteFrom,
  onOriginChange,
  originKeyOf,
  routeForOrigin,
  type RouteTarget,
} from '../../lib/route-origin'
import { useUserLocation } from '../../lib/use-user-location'
import {
  GENDER_TYPES,
  RESTROOM_KINDS,
  type GenderType,
  type Restroom,
  type RestroomKind,
} from '../../schemas/restrooms-schema'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const START_ZOOM = 14
const SEED_DEBOUNCE_MS = 700
const SEED_BACKOFF_BASE_MS = 30_000
const SEED_BACKOFF_MAX_MS = 10 * 60_000
const KIND_COLOR: Record<RestroomKind, string> = { public: '#0d9488', restaurant: '#ea580c' }
const UNAVAILABLE_COLOR = '#9ca3af'
/** Below this zoom no cells load and restroom markers hide. */
const MIN_VIEW_ZOOM = 12
/** Cells subscribed for one view, nearest the centre first. */
const MAX_VIEW_CELLS = 36
/** Recently used cells stay subscribed so panning back is instant. */
const RETAINED_CELLS = 64
/** Auto-select only picks a restroom this close; farther is not "nearby". */
const AUTO_SELECT_MAX_METERS = 5000
/** Auto-select compares walking time for this many straight-line-nearest restrooms. */
const AUTO_SELECT_CANDIDATES = 6
/** Past this, auto-select falls back to the straight-line nearest. */
const AUTO_SELECT_TABLE_TIMEOUT_MS = 2000
/** Seeding waits this long for the first location answer before using the default city. */
const SEED_LOCATION_WAIT_MS = 6000
/** The selected marker's halo when not pulsing (reduced motion). */
const HALO_REST = { radius: 24, opacity: 0.5 }
/** Hit area around a click, so small markers are easy to tap. */
const CLICK_TOLERANCE_PX = 8
const MARKER_LAYERS = ['restroom-selected', 'restroom-destination', 'restrooms']
const ROUTE_COLOR = '#2563eb'
/** Required by the ODbL for OpenStreetMap data (tiles, restrooms, search, routes). */
const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
/** Beyond this straight-line distance no route is requested (heavy for the service). */
const MAX_ROUTE_METERS = 50_000
const markerColor = [
  'case',
  ['!=', ['get', 'status'], 'active'],
  UNAVAILABLE_COLOR,
  ['match', ['get', 'kind'], 'restaurant', KIND_COLOR.restaurant, KIND_COLOR.public],
] as ExpressionSpecification

type RestroomRecord = CellRecords['records'][number]
/** What the panel needs from a route: its length and duration. */
type RouteSummary = Pick<Route, 'kind' | 'distance' | 'duration'>

const GENDER_LABEL: Record<GenderType, string> = {
  men: 'Men',
  women: 'Women',
  'gender-neutral': 'Gender-neutral',
  unknown: 'Unknown',
}
const KIND_LABEL: Record<RestroomKind, string> = { public: 'Public', restaurant: 'Restaurant' }

export default function HomePage() {
  const { user } = useAuthProfileReady({ requireUser: true })
  const isAdmin = user?.role === 'admin'
  // Restrooms arrive per subscribed grid cell (RestroomCells reports each).
  const [subscribedCells, setSubscribedCells] = useState<string[]>([])
  const [cellData, setCellData] = useState<Map<string, CellRecords>>(() => new Map())
  const [zoomedOut, setZoomedOut] = useState(false)
  const onCellReport = useCallback((key: string, value: CellRecords | null) => {
    setCellData((prev) => {
      if (!value && !prev.has(key)) return prev
      const next = new Map(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }, [])
  const records = useMemo(() => [...cellData.values()].flatMap((c) => c.records), [cellData])
  const recordsStatus =
    subscribedCells.length > 0 && subscribedCells.every((k) => cellData.get(k)?.ready) ? 'ready' : 'loading'

  const [genders, setGenders] = useState<Set<GenderType>>(() => new Set(GENDER_TYPES))
  const [kinds, setKinds] = useState<Set<RestroomKind>>(() => new Set(RESTROOM_KINDS))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tooFarOut, setTooFarOut] = useState(false)
  const loc = useUserLocation()
  const userLocation = loc.location
  /** The current origin: every route is tied to the origin it was requested from. */
  const locationKey = originKeyOf(userLocation)
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [seedState, setSeedState] = useState<'idle' | 'loading' | 'error'>('idle')
  // Once per page load: set after the auto-selection, or when the user
  // selects, closes, pans, or filters while their location is known.
  const autoSelectDone = useRef(false)
  // The walking-time comparison in flight, and whether the visitor acted
  // (selected, panned, filtered) while it was — then its answer is dropped.
  const autoSelectAbort = useRef<AbortController | null>(null)
  const autoSelectInterrupted = useRef(false)
  // Walking duration/distance of the auto-selected restroom, from the
  // comparison, shown in its panel without another request.
  // The location the closest-restroom pick last completed for (overlay).
  const [pickedFor, setPickedFor] = useState<string | null>(null)
  // The location the pick found no restroom in range for (it keeps watching).
  const [nothingFoundFor, setNothingFoundFor] = useState<string | null>(null)
  const [walkLeg, setWalkLeg] = useState<(NonNullable<WalkLeg> & { recordId: string; fromKey: string }) | null>(null)
  const locationRef = useRef<Point | null>(userLocation)
  const pickingRef = useRef(false)
  useEffect(() => {
    locationRef.current = userLocation
    pickingRef.current = picking
  })
  // Seeding stays closed until the first location answer (or a timeout), so a
  // visitor elsewhere does not trigger fetches for the default city.
  const seedGateOpen = useRef(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const maplibreRef = useRef<typeof import('maplibre-gl') | null>(null)
  const userMarkerRef = useRef<MapLibreMarker | null>(null)
  const [mapReady, setMapReady] = useState(false)

  // Routing. The route target is the last selected restroom; it outlives the
  // panel. `route` is what is drawn: a real route, or a straight fallback.
  // The route destination, with the origin it was chosen from (rule 3).
  const [routeTargetState, setRouteTargetState] = useState<RouteTarget | null>(null)
  const routeTargetId = routeTargetState?.id ?? null
  /** Set the route destination, remembering the current origin with it. */
  const setRouteTargetId = (id: string | null) =>
    setRouteTargetState(id ? { id, originKey: locationKey } : null)
  const [travelMode, setTravelMode] = useState<TravelMode>('walk')
  const [route, setRoute] = useState<{
    key: string
    /** The origin this route was requested from (see src/lib/route-origin.ts). */
    originKey: string
    targetId: string
    mode: TravelMode
    result: Route | { kind: 'fallback'; coordinates: LineCoords }
  } | null>(null)
  const [routePending, setRoutePending] = useState(false)

  const visible = useMemo(
    () =>
      records.filter((r) => kinds.has(r.data.kind) && genders.has(r.data.genderType ?? 'unknown')),
    [records, kinds, genders],
  )
  // The selected restroom and the route target keep their last-seen record,
  // so the panel and route survive their cell unloading (pan away, zoom out).
  // The copy only stands in while that cell is not loaded: if the cell is
  // loaded and the restroom is gone, the server removed it (e.g. it became
  // unavailable), so it must disappear here too.
  const byId = useMemo(() => new Map(records.map((r) => [r.recordId, r])), [records])
  const pinned = useRef(new Map<string, RestroomRecord>())
  const lookup = (id: string | null): RestroomRecord | null => {
    if (!id) return null
    const live = byId.get(id)
    if (live) return live
    const copy = pinned.current.get(id)
    if (!copy || cellData.get(copy.data.cellKey)?.ready) return null
    return copy
  }
  const selected = lookup(selectedId)
  const routeTarget = lookup(routeTargetId)
  // Only a route requested from the current origin is ever drawn or shown.
  const drawnRoute = routeForOrigin(route, locationKey)
  useEffect(() => {
    const keep = new Map<string, RestroomRecord>()
    for (const id of [selectedId, routeTargetId]) {
      const live = id ? byId.get(id) : undefined
      const copy = id ? pinned.current.get(id) : undefined
      const removed = copy && !live && cellData.get(copy.data.cellKey)?.ready
      if (id && (live ?? (removed ? undefined : copy))) keep.set(id, (live ?? copy)!)
    }
    pinned.current = keep
  }, [byId, cellData, selectedId, routeTargetId])

  // A restroom removed while selected (e.g. marked unavailable) closes its
  // panel; one removed while it was the route target drops the route.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null)
    if (routeTargetId && !routeTarget) setRouteTargetId(null)
  }, [selectedId, selected, routeTargetId, routeTarget])

  // Which cells to subscribe: the ones in view (capped), plus recently used.
  const retainedCells = useRef<string[]>([])
  const updateCells = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (map.getZoom() < MIN_VIEW_ZOOM) {
      setZoomedOut(true)
      return
    }
    setZoomedOut(false)
    const b = map.getBounds()
    const c = map.getCenter()
    const inView = cellsInView(
      { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
      { latitude: c.lat, longitude: c.lng },
      MAX_VIEW_CELLS,
    ).map((cell) => cell.key)
    const next = [...inView, ...retainedCells.current.filter((k) => !inView.includes(k))].slice(
      0,
      RETAINED_CELLS,
    )
    retainedCells.current = next
    setSubscribedCells((prev) =>
      prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next,
    )
  }, [])
  const routeTargetIdRef = useRef<string | null>(null)
  useEffect(() => {
    routeTargetIdRef.current = routeTargetId
  })

  /**
   * Set the visitor's location by hand (map tap or typed). The map moves to
   * it at a zoom where restrooms load, so the ones around it appear. The new
   * origin discards the old route and selection and starts a new closest-
   * restroom pick (the origin-change effect below).
   */
  const setManual = loc.setManual
  const setManualLocation = useCallback(
    (p: ManualLocation) => {
      setManual(p)
      // Arriving there fires moveend, which seeds the cells around it.
      mapRef.current?.easeTo({
        center: [p.longitude, p.latitude],
        zoom: Math.max(START_ZOOM, MIN_SEED_ZOOM),
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800,
      })
    },
    [setManual],
  )

  /** User interaction ends the auto-select window, once a location is known. */
  const markInteraction = useCallback(() => {
    if (locationRef.current) {
      autoSelectDone.current = true
      autoSelectInterrupted.current = true
    }
  }, [])

  const select = useCallback(
    (id: string | null) => {
      markInteraction()
      setSelectedId(id)
    },
    [markInteraction],
  )

  // Seeding. A cell is requested until it succeeds (or is refused as outside
  // the US). A failure stops the batch — Overpass being down affects every
  // cell — and backs off exponentially before the next automatic attempt.
  const seeded = useRef(new Set<string>())
  const backoff = useRef(new Map<string, { attempts: number; retryAt: number }>())
  const running = useRef(false)
  const rerun = useRef(false)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const seedView = useCallback(async (force = false) => {
    const map = mapRef.current
    if (!map || !seedGateOpen.current) return
    if (running.current) {
      rerun.current = true
      return
    }
    if (map.getZoom() < MIN_SEED_ZOOM) {
      setTooFarOut(true)
      return
    }
    setTooFarOut(false)
    const b = map.getBounds()
    const c = map.getCenter()
    const now = Date.now()
    const cells = cellsInView(
      { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
      { latitude: c.lat, longitude: c.lng },
    ).filter((cell) => {
      if (seeded.current.has(cell.key)) return false
      const wait = backoff.current.get(cell.key)
      return force || !wait || wait.retryAt <= now
    })
    if (cells.length === 0) {
      return
    }

    running.current = true
    setSeedState('loading')
    let failed = false
    // Sequential: Overpass rate-limits concurrent queries from one client.
    for (const cell of cells) {
      let retryAfterSeconds: number | undefined
      try {
        const res = await fetch('/api/restrooms/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cellKey: cell.key }),
        })
        if (res.ok || res.status === 422) {
          seeded.current.add(cell.key)
          backoff.current.delete(cell.key)
          continue
        }
        const body = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null
        retryAfterSeconds = body?.retryAfterSeconds
      } catch {
        // Network error: treated like an upstream failure below.
      }
      const attempts = (backoff.current.get(cell.key)?.attempts ?? 0) + 1
      const delay = Math.min(
        Math.max(SEED_BACKOFF_BASE_MS * 2 ** (attempts - 1), (retryAfterSeconds ?? 0) * 1000),
        SEED_BACKOFF_MAX_MS,
      )
      backoff.current.set(cell.key, { attempts, retryAt: Date.now() + delay })
      clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => void seedView(), delay)
      failed = true
      break
    }
    running.current = false
    setSeedState(failed ? 'error' : 'idle')
    if (rerun.current && !failed) {
      rerun.current = false
      void seedView()
    }
    rerun.current = false
  }, [])

  // Create the map once, right away: at a location set earlier this session,
  // else the default city. A GPS fix recenters it when it arrives.
  useEffect(() => {
    let cancelled = false
    let map: MapLibreMap | null = null
    let debounce: ReturnType<typeof setTimeout> | undefined
    let gateTimer: ReturnType<typeof setTimeout> | undefined

    void (async () => {
      const maplibre = await import('maplibre-gl')
      const maplibregl = maplibre.default
      if (cancelled || !containerRef.current) return
      maplibreRef.current = maplibregl

      const center = locationRef.current ?? DEFAULT_CENTER
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: [center.longitude, center.latitude],
        zoom: START_ZOOM,
        maxBounds: US_MAX_BOUNDS,
        attributionControl: { compact: true, customAttribution: [OSM_ATTRIBUTION, ROUTING_ATTRIBUTION] },
      })
      mapRef.current = map
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')

      map.on('load', () => {
        if (!map) return
        map.addSource('restrooms', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        })
        map.addLayer({
          id: 'restrooms',
          type: 'circle',
          source: 'restrooms',
          paint: {
            'circle-radius': ['match', ['get', 'kind'], 'restaurant', 6, 8],
            'circle-color': markerColor,
            'circle-stroke-width': ['match', ['get', 'kind'], 'restaurant', 1.5, 3],
            'circle-stroke-color': '#ffffff',
          },
        })
        // Route line under every marker: a white casing, then a solid line for a
        // real route or a dashed one for the straight-line fallback.
        map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer(
          {
            id: 'route-casing',
            type: 'line',
            source: 'route',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
          },
          'restrooms',
        )
        map.addLayer(
          {
            id: 'route-line',
            type: 'line',
            source: 'route',
            filter: ['==', ['get', 'kind'], 'route'],
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ROUTE_COLOR, 'line-width': 5 },
          },
          'restrooms',
        )
        map.addLayer(
          {
            id: 'route-fallback',
            type: 'line',
            source: 'route',
            filter: ['==', ['get', 'kind'], 'fallback'],
            layout: { 'line-cap': 'butt' },
            paint: { 'line-color': ROUTE_COLOR, 'line-width': 4, 'line-dasharray': [1.5, 1.5] },
          },
          'restrooms',
        )
        // The end of a route whose panel is closed: a ring in the restroom's
        // colour, quieter than the selected glow.
        map.addLayer({
          id: 'restroom-destination',
          type: 'circle',
          source: 'restrooms',
          filter: ['==', ['get', 'id'], ''],
          paint: {
            'circle-radius': 9,
            'circle-color': '#ffffff',
            'circle-stroke-width': 4,
            'circle-stroke-color': markerColor,
          },
        })
        // The selected marker is drawn by these two layers (filtered to its id)
        // and excluded from the base layer: a soft halo under a larger dot.
        map.addLayer({
          id: 'restroom-halo',
          type: 'circle',
          source: 'restrooms',
          filter: ['==', ['get', 'id'], ''],
          paint: {
            'circle-radius': HALO_REST.radius,
            'circle-color': markerColor,
            'circle-opacity': HALO_REST.opacity,
            'circle-blur': 0.5,
          },
        })
        map.addLayer({
          id: 'restroom-selected',
          type: 'circle',
          source: 'restrooms',
          filter: ['==', ['get', 'id'], ''],
          paint: {
            'circle-radius': 12,
            'circle-color': markerColor,
            'circle-stroke-width': 3,
            'circle-stroke-color': '#ffffff',
          },
        })
        // One click handler decides: a marker under the pointer selects it,
        // empty map clears the selection.
        map.on('click', (e) => {
          if (!map) return
          if (pickingRef.current) {
            const { lat, lng } = e.lngLat
            if (!isInUSOutline(lat, lng)) {
              setPickError('That point is outside the US. Pick a spot inside the US.')
              return
            }
            setPickError(null)
            setPicking(false)
            setManualLocation({ latitude: lat, longitude: lng })
            return
          }
          const { x, y } = e.point
          const t = CLICK_TOLERANCE_PX
          const hit = map.queryRenderedFeatures(
            [
              [x - t, y - t],
              [x + t, y + t],
            ],
            { layers: MARKER_LAYERS },
          )[0]
          const id = hit?.properties?.id
          select(typeof id === 'string' ? id : null)
        })
        for (const layer of MARKER_LAYERS) {
          map.on('mouseenter', layer, () => {
            if (map) map.getCanvas().style.cursor = 'pointer'
          })
          map.on('mouseleave', layer, () => {
            if (map) map.getCanvas().style.cursor = ''
          })
        }
        setMapReady(true)
        updateCells()
        gateTimer = setTimeout(() => {
          seedGateOpen.current = true
          void seedView()
        }, SEED_LOCATION_WAIT_MS)
      })

      // A user pan or zoom (not our own easeTo) ends the auto-select window.
      map.on('movestart', (e) => {
        if (e.originalEvent) markInteraction()
      })

      map.on('moveend', () => {
        updateCells()
        clearTimeout(debounce)
        debounce = setTimeout(() => {
          void seedView()
        }, SEED_DEBOUNCE_MS)
      })
    })()

    return () => {
      cancelled = true
      clearTimeout(debounce)
      clearTimeout(gateTimer)
      clearTimeout(retryTimer.current)
      userMarkerRef.current = null
      map?.remove()
      mapRef.current = null
    }
    // loc.setManual is a stable callback; the map is created once.
  }, [seedView, select, markInteraction, setManualLocation, updateCells])

  // Open seeding once the first location answer is in.
  useEffect(() => {
    if (!loc.settled || !mapReady || seedGateOpen.current) return
    seedGateOpen.current = true
    void seedView()
  }, [loc.settled, mapReady, seedView])

  // The first GPS fix of the page load recenters the map on it, unless the
  // visitor has set their own location.
  const centeredOnGps = useRef(false)
  useEffect(() => {
    const map = mapReady ? mapRef.current : null
    if (!map || !loc.gps || centeredOnGps.current || loc.manual) return
    centeredOnGps.current = true
    map.jumpTo({ center: [loc.gps.longitude, loc.gps.latitude] })
  }, [loc.gps, loc.manual, mapReady])

  // The user dot: solid blue for GPS, dashed violet ring for a set location.
  useEffect(() => {
    const map = mapReady ? mapRef.current : null
    const maplibre = maplibreRef.current
    userMarkerRef.current?.remove()
    userMarkerRef.current = null
    if (!map || !maplibre || !userLocation || !loc.source) return
    const el = document.createElement('div')
    el.dataset.testid = `user-dot-${loc.source}`
    el.title = loc.source === 'gps' ? 'Your location' : 'Location you set'
    Object.assign(
      el.style,
      loc.source === 'gps'
        ? {
            width: '16px',
            height: '16px',
            borderRadius: '9999px',
            background: '#2563eb',
            border: '3px solid #ffffff',
            boxShadow: '0 0 0 6px rgba(37, 99, 235, 0.25)',
          }
        : {
            width: '18px',
            height: '18px',
            borderRadius: '9999px',
            background: 'rgba(124, 58, 237, 0.15)',
            border: '3px dashed #7c3aed',
          },
    )
    userMarkerRef.current = new maplibre.Marker({ element: el })
      .setLngLat([userLocation.longitude, userLocation.latitude])
      .addTo(map)
  }, [userLocation, loc.source, mapReady])

  // Crosshair cursor while picking a location.
  useEffect(() => {
    const canvas = mapReady ? mapRef.current?.getCanvas() : undefined
    if (canvas) canvas.style.cursor = picking ? 'crosshair' : ''
  }, [picking, mapReady])

  // What the map draws: the filtered restrooms (none when zoomed out), plus
  // the selected restroom and route destination wherever they are.
  const mapRecords = useMemo(() => {
    const drawn = zoomedOut ? [] : [...visible]
    for (const r of [selected, routeTarget]) {
      if (r && !drawn.some((d) => d.recordId === r.recordId)) drawn.push(r)
    }
    return drawn
  }, [zoomedOut, visible, selected, routeTarget])

  // Push them into the map source.
  useEffect(() => {
    const source = mapReady ? mapRef.current?.getSource<GeoJSONSource>('restrooms') : undefined
    source?.setData({
      type: 'FeatureCollection',
      features: mapRecords.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.data.longitude, r.data.latitude] },
        properties: { id: r.recordId, kind: r.data.kind, status: r.data.status },
      })),
    })
  }, [mapRecords, mapReady])

  // Show the selection: base layer without it, halo and large dot with it.
  useEffect(() => {
    const map = mapReady ? mapRef.current : null
    if (!map) return
    const id = selectedId ?? ''
    // The destination ring shows only while its restroom is not selected.
    const dest = routeTargetId && routeTargetId !== selectedId && drawnRoute ? routeTargetId : ''
    map.setFilter('restrooms', ['all', ['!=', ['get', 'id'], id], ['!=', ['get', 'id'], dest]])
    map.setFilter('restroom-destination', ['==', ['get', 'id'], dest])
    map.setFilter('restroom-halo', ['==', ['get', 'id'], id])
    map.setFilter('restroom-selected', ['==', ['get', 'id'], id])
    if (!selectedId || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      map.setPaintProperty('restroom-halo', 'circle-radius', HALO_REST.radius)
      map.setPaintProperty('restroom-halo', 'circle-opacity', HALO_REST.opacity)
      return
    }
    // Gentle pulse: the halo breathes over ~1.6 s.
    let frame = requestAnimationFrame(function pulse(time) {
      const phase = (Math.sin((time / 1600) * 2 * Math.PI) + 1) / 2
      map.setPaintProperty('restroom-halo', 'circle-radius', 20 + 10 * phase)
      map.setPaintProperty('restroom-halo', 'circle-opacity', 0.7 - 0.35 * phase)
      frame = requestAnimationFrame(pulse)
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, routeTargetId, drawnRoute, mapReady])

  // A selection becomes the route target; closing the panel keeps the target.
  useEffect(() => {
    if (selectedId) setRouteTargetId(selectedId)
  }, [selectedId])

  // Request the route: one request per target, travel mode, or location,
  // cancelled when any of them changes. Failure or timeout → dashed fallback.
  const fromLat = userLocation?.latitude
  const fromLng = userLocation?.longitude
  const toLat = routeTarget?.data.latitude
  const toLng = routeTarget?.data.longitude
  const fitPending = useRef(false)
  useEffect(() => {
    // Only to a destination chosen from this same origin: in the render where
    // the origin changes, the old destination is still set until the
    // origin-change effect drops it, and must not get a route (or a straight
    // fallback line) from the new origin.
    if (!canRouteFrom(routeTargetState, locationKey) || fromLat === undefined || fromLng === undefined) {
      setRoute(null)
      setRoutePending(false)
      return
    }
    if (toLat === undefined || toLng === undefined) return
    const target = routeTargetState
    const from = { latitude: fromLat, longitude: fromLng }
    const to = { latitude: toLat, longitude: toLng }
    const key = routeKey(travelMode, from, to)
    const controller = new AbortController()
    setRoutePending(true)
    const request =
      distanceMeters(from, to) > MAX_ROUTE_METERS
        ? Promise.resolve(null) // too far to route: straight line, no request
        : fetchRoute(travelMode, from, to, controller.signal)
    request
      .then((result) => {
        fitPending.current = true
        setRoute({
          key,
          originKey: originKeyOf(from)!,
          targetId: target.id,
          mode: travelMode,
          result: result ?? {
            kind: 'fallback',
            coordinates: [
              [fromLng, fromLat],
              [toLng, toLat],
            ],
          },
        })
        setRoutePending(false)
      })
      .catch(() => {
        // Aborted: a newer request owns the state.
      })
    return () => controller.abort()
  }, [routeTargetId, routeTargetState, locationKey, travelMode, fromLat, fromLng, toLat, toLng])

  // Draw the route, and fit it into view when a new one arrives. Closing the
  // panel does not produce a new route, so it never moves the map.
  useEffect(() => {
    const map = mapReady ? mapRef.current : null
    if (!map) return
    const line = (coordinates: LineCoords, kind: 'route' | 'fallback') => ({
      type: 'Feature' as const,
      geometry: { type: 'LineString' as const, coordinates },
      properties: { kind },
    })
    const features = drawnRoute ? [line(drawnRoute.result.coordinates, drawnRoute.result.kind)] : []
    // A real route starts and ends on the nearest road; dashed connectors
    // join it to the visitor and the restroom when the gap is noticeable.
    if (drawnRoute?.result.kind === 'route' && userLocation && routeTarget) {
      const coords = drawnRoute.result.coordinates
      const ends: [Point, [number, number]][] = [
        [userLocation, coords[0]],
        [routeTarget.data, coords[coords.length - 1]],
      ]
      for (const [p, [lng, lat]] of ends) {
        if (distanceMeters(p, { latitude: lat, longitude: lng }) > 10) {
          features.push(line([[p.longitude, p.latitude], [lng, lat]], 'fallback'))
        }
      }
    }
    map.getSource<GeoJSONSource>('route')?.setData({ type: 'FeatureCollection', features })
    if (!drawnRoute || !fitPending.current) return
    fitPending.current = false
    const coords = drawnRoute.result.coordinates
    const lngs = coords.map((c) => c[0])
    const lats = coords.map((c) => c[1])
    const wide = window.innerWidth >= 640
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      {
        // Keep the line clear of the filter column and the details panel.
        padding: wide
          ? { top: 60, right: 60, bottom: 60, left: 430 }
          : { top: 300, right: 30, bottom: 340, left: 30 },
        maxZoom: 17,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 600,
      },
    )
    // userLocation/routeTarget only shape the connectors; a new route is what fits.
  }, [drawnRoute, mapReady, userLocation, routeTarget])

  // Auto-select the nearest matching restroom, once per page load, when a
  // location (GPS or set on the map) becomes known. It waits for a seeding
  // pass that started afterwards, or a few seconds, so nearby rows are in.
  const selectedIdRef = useRef<string | null>(null)
  const locationKeyRef = useRef<string | null>(null)
  useEffect(() => {
    selectedIdRef.current = selectedId
    locationKeyRef.current = locationKey
  })
  useEffect(() => () => autoSelectAbort.current?.abort(), [])
  // Rule: a route belongs to its origin. When the origin changes (recenter,
  // typed or tapped location), the old route, destination and selection are
  // discarded and the closest-restroom pick runs again from the new origin.
  // Drawing is already gated by routeForOrigin, so nothing stale is drawn
  // even in the render before this runs.
  const originRef = useRef<string | null>(locationKey)
  useEffect(() => {
    const previous = originRef.current
    originRef.current = locationKey
    if (previous === locationKey || previous === null) return // first location: nothing chosen yet
    const next = onOriginChange(
      { originKey: previous, targetId: routeTargetIdRef.current, selectedId: selectedIdRef.current },
      locationKey,
    )
    setRouteTargetId(next.targetId)
    setSelectedId(next.selectedId)
    setRoute(null)
    setWalkLeg(null)
    autoSelectAbort.current?.abort()
    autoSelectDone.current = false
    autoSelectInterrupted.current = false
  }, [locationKey])

  // Bumped by "Recenter on me" to run the pick again even when the origin
  // itself does not change (already on the device location).
  const [pickNonce, setPickNonce] = useState(0)

  // The cell under the current location has its restrooms. The pick (and the
  // loading overlay) wait for this — never for live seeding: right after a
  // move the old area's cells are still "ready", hence the location cell.
  const locationCell = userLocation ? cellForPoint(userLocation.latitude, userLocation.longitude).key : null
  const locationCellsReady =
    !zoomedOut && recordsStatus === 'ready' && !!locationCell && subscribedCells.includes(locationCell)

  useEffect(() => {
    if (autoSelectDone.current || !userLocation || !mapReady || selectedId) return
    // Pick once the restrooms around the location have loaded from the
    // database. Live seeding is not awaited: in imported areas it adds
    // nothing, and elsewhere new rows re-run this effect as they arrive.
    if (!locationCellsReady) return
    // Candidates: the nearest restrooms in a straight line, within range.
    // None nearby loaded yet: keep watching (rows from live seeding re-run
    // this) rather than selecting something across the country.
    const candidates = visible
      .map((r) => ({ r, d: distanceMeters(userLocation, r.data) }))
      .filter((c) => c.d <= AUTO_SELECT_MAX_METERS)
      .sort((a, b) => a.d - b.d)
      .slice(0, AUTO_SELECT_CANDIDATES)
      .map((c) => c.r)
    if (candidates.length === 0) {
      setNothingFoundFor(locationKey)
      return
    }
    // Claim this page load's one auto-select now; nothing is selected until
    // the walking-time comparison answers (or times out).
    autoSelectDone.current = true
    autoSelectInterrupted.current = false
    const controller = new AbortController()
    autoSelectAbort.current = controller
    const from = userLocation
    const fromKey = locationKey!
    fetchWalkingTable(from, candidates.map((c) => c.data), controller.signal, AUTO_SELECT_TABLE_TIMEOUT_MS)
      .catch(() => null)
      .then((legs) => {
        // Moved, selected, panned or filtered meanwhile: their choice stands.
        if (controller.signal.aborted || autoSelectInterrupted.current) return
        if (selectedIdRef.current || locationKeyRef.current !== fromKey) return
        const index = chooseByWalkingTime(candidates.length, legs)
        const chosen = candidates[index]
        const leg = legs?.[index]
        setWalkLeg(leg ? { ...leg, recordId: chosen.recordId, fromKey } : null)
        setSelectedId(chosen.recordId)
        setPickedFor(fromKey)
        const map = mapRef.current
        const at: [number, number] = [chosen.data.longitude, chosen.data.latitude]
        if (map && !map.getBounds().contains(at)) map.easeTo({ center: at })
      })
  }, [
    userLocation,
    locationKey,
    mapReady,
    selectedId,
    locationCellsReady,
    visible,
    pickNonce,
  ])

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || overlayRef.current) return
      if (pickingRef.current) {
        setPicking(false)
        setPickError(null)
      } else select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

  // ---------------------------------------------------------------------------
  // Blocking loading overlay: first load (cap 5 s) and re-picks after
  // "Recenter on me" or a typed location (cap 3 s). See src/lib/loading-overlay.ts.
  // ---------------------------------------------------------------------------
  const [overlay, setOverlay] = useState<{ kind: OverlayKind; startedAt: number } | null>(() => ({
    kind: 'initial',
    startedAt: Date.now(),
  }))
  const overlayRef = useRef(overlay)
  useEffect(() => {
    overlayRef.current = overlay
  })
  const startOverlay = useCallback((kind: OverlayKind) => {
    setPickedFor(null)
    setNothingFoundFor(null)
    setOverlay({ kind, startedAt: Date.now() })
  }, [])
  const closeOverlay = useCallback(() => setOverlay(null), [])

  const cellsReady = zoomedOut || (userLocation ? locationCellsReady : recordsStatus === 'ready')
  const locationPending = !loc.settled || loc.gpsStatus === 'locating'
  const nothingNearby = !!locationKey && nothingFoundFor === locationKey
  const loadingDone = overlayDone({
    mapReady,
    cellsReady,
    hasLocation: !!userLocation,
    locationPending,
    picked: !!locationKey && pickedFor === locationKey,
    selected: !!selectedId,
    routeDrawn: !!selectedId && drawnRoute?.targetId === selectedId,
    nothingNearby,
  })
  // Close when everything is in…
  useEffect(() => {
    if (overlay && loadingDone) setOverlay(null)
  }, [overlay, loadingDone])
  // …or at the cap, whatever is still pending (it keeps loading behind).
  useEffect(() => {
    if (!overlay) return
    const left = overlay.startedAt + OVERLAY_CAP_MS[overlay.kind] - Date.now()
    const timer = setTimeout(() => setOverlay(null), Math.max(0, left))
    return () => clearTimeout(timer)
  }, [overlay])
  // Focus: into the overlay while it is up; back to the map when it closes.
  const overlayBoxRef = useRef<HTMLDivElement>(null)
  const hadOverlay = useRef(false)
  useEffect(() => {
    if (overlay) {
      overlayBoxRef.current?.focus()
      hadOverlay.current = true
    } else if (hadOverlay.current) {
      hadOverlay.current = false
      mapRef.current?.getCanvas().focus()
    }
  }, [overlay])
  const askingForLocation =
    !userLocation && locationPending && loc.permission !== 'granted' && loc.permission !== 'denied'

  /**
   * "Recenter on me": back to the device location (dropping any typed one),
   * centred there, old route and destination gone, and the closest-restroom
   * pick run again exactly as on first load — the one allowed exception to
   * once-per-page-load, because the visitor asked. False when the device
   * location is unavailable; then nothing changes.
   */
  const clearManual = loc.clearManual
  const recenterOnMe = useCallback((): boolean => {
    const gps = loc.gps
    if (!gps) return false
    setRouteTargetId(null)
    setSelectedId(null)
    setRoute(null)
    setWalkLeg(null)
    autoSelectAbort.current?.abort()
    autoSelectDone.current = false
    autoSelectInterrupted.current = false
    clearManual()
    setPickNonce((n) => n + 1)
    startOverlay('repick')
    mapRef.current?.easeTo({
      center: [gps.longitude, gps.latitude],
      zoom: Math.max(START_ZOOM, MIN_SEED_ZOOM),
      duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800,
    })
    return true
  }, [loc.gps, clearManual, startOverlay])

  const toggle = <T,>(set: Set<T>, value: T, update: (next: Set<T>) => void) => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    markInteraction()
    update(next)
    // A filter that hides the selected restroom also closes its panel.
    const hidden = selected && (selected.data.kind === value || selected.data.genderType === value)
    if (hidden && !next.has(value)) setSelectedId(null)
  }

  return (
    <div className="relative h-full w-full">
      {/* While the loading overlay is up, nothing behind it takes clicks, typing or focus. */}
      <div className="absolute inset-0" inert={!!overlay}>
      {/* maplibre's unlayered `.maplibregl-map { position: relative }` beats
          Tailwind's layered utilities, so the map element itself must not rely
          on `absolute inset-0` for its size — the wrapper provides it. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" data-testid="restroom-map" />
      </div>
      <RestroomCells cellKeys={subscribedCells} onReport={onCellReport} />

      {/* Above the details panel: an open location panel must stay usable. */}
      <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-col gap-2 sm:right-auto sm:w-80">
        <section className="pointer-events-auto rounded-lg border border-border bg-card/95 p-3 text-card-foreground shadow-card backdrop-blur">
          <FilterRow label="Type">
            {RESTROOM_KINDS.map((k) => (
              <Chip
                key={k}
                active={kinds.has(k)}
                onClick={() => toggle(kinds, k, setKinds)}
                swatch={KIND_COLOR[k]}
              >
                {KIND_LABEL[k]}
              </Chip>
            ))}
          </FilterRow>
          <FilterRow label="Gender">
            {GENDER_TYPES.map((g) => (
              <Chip key={g} active={genders.has(g)} onClick={() => toggle(genders, g, setGenders)}>
                {GENDER_LABEL[g]}
              </Chip>
            ))}
          </FilterRow>
          <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
            {zoomedOut ? 'Zoom in to see restrooms' : `${visible.length} shown`}
            {seedState === 'loading' && ' · loading nearby restrooms…'}
            {tooFarOut && ' · zoom in to load more'}
          </p>
          {seedState === 'error' && (
            <p
              data-testid="seed-error"
              className="mt-2 flex items-center justify-between gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs"
            >
              Couldn&apos;t load new restrooms.
              <button
                type="button"
                onClick={() => void seedView(true)}
                className="font-medium text-foreground underline underline-offset-2"
              >
                Retry
              </button>
            </p>
          )}
        </section>

        <LocationControl
          loc={loc}
          picking={picking}
          pickError={pickError}
          onStartPick={() => {
            setPickError(null)
            setPicking(true)
          }}
          onChoosePlace={(place) => {
            setPickError(null)
            setPicking(false)
            startOverlay('repick')
            setManualLocation(place)
          }}
          onCancelPick={() => {
            setPickError(null)
            setPicking(false)
          }}
          onRecenter={recenterOnMe}
        />

        {drawnRoute && (
          <button
            type="button"
            data-testid="clear-route"
            onClick={() => setRouteTargetId(null)}
            className="pointer-events-auto inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs font-medium text-card-foreground shadow-card backdrop-blur"
          >
            <RouteIcon className="h-3.5 w-3.5" />
            Clear route
          </button>
        )}
      </div>

      {selected && (
        <RestroomDetails
          id={selected.recordId}
          restroom={selected.data}
          userLocation={userLocation}
          travelMode={travelMode}
          onTravelModeChange={(mode) => {
            setTravelMode(mode)
            // Also brings the route back if it was cleared with the panel open.
            setRouteTargetId(selected.recordId)
          }}
          route={(() => {
            const own =
              drawnRoute && drawnRoute.targetId === selected.recordId && drawnRoute.mode === travelMode
                ? drawnRoute.result
                : null
            if (own?.kind === 'route') return own
            // The auto-select comparison already measured this walk.
            const measured =
              walkLeg &&
              travelMode === 'walk' &&
              walkLeg.recordId === selected.recordId &&
              walkLeg.fromKey === locationKey
                ? { kind: 'route' as const, distance: walkLeg.distance, duration: walkLeg.duration }
                : null
            return measured ?? own
          })()}
          routePending={routePending}
          showAdminInfo={isAdmin}
          onClose={() => select(null)}
        />
      )}
      </div>

      {overlay && (
        <div
          ref={overlayBoxRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-busy="true"
          aria-labelledby="loading-overlay-message"
          data-testid="loading-overlay"
          data-kind={overlay.kind}
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 px-4 outline-none backdrop-blur-[2px]"
        >
          <div className="w-full max-w-xs rounded-lg border border-border bg-card p-5 text-center text-card-foreground shadow-card">
            <Loader2 aria-hidden="true" className="mx-auto h-6 w-6 animate-spin text-primary" />
            <p id="loading-overlay-message" role="status" aria-live="polite" className="mt-3 text-sm font-medium">
              {askingForLocation
                ? 'Waiting for your location…'
                : overlay.kind === 'repick'
                  ? 'Finding the closest restroom…'
                  : 'Finding restrooms near you…'}
            </p>
            {askingForLocation && (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  Answer your browser&apos;s location prompt, or continue without it.
                </p>
                <button
                  type="button"
                  data-testid="continue-without-location"
                  onClick={closeOverlay}
                  className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Continue without location
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}

function Chip({
  active,
  onClick,
  swatch,
  children,
}: {
  active: boolean
  onClick: () => void
  swatch?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-background text-muted-foreground hover:text-foreground',
      )}
    >
      {swatch && (
        <span className="h-2.5 w-2.5 rounded-full ring-1 ring-white" style={{ background: swatch }} />
      )}
      {children}
    </button>
  )
}

function RestroomDetails({
  id,
  restroom,
  userLocation,
  travelMode,
  onTravelModeChange,
  route,
  routePending,
  showAdminInfo,
  onClose,
}: {
  id: string
  restroom: Restroom
  userLocation: { latitude: number; longitude: number } | null
  travelMode: TravelMode
  onTravelModeChange: (mode: TravelMode) => void
  route: RouteSummary | { kind: 'fallback' } | null
  routePending: boolean
  showAdminInfo: boolean
  onClose: () => void
}) {
  const isRestaurant = restroom.kind === 'restaurant'

  return (
    <section
      data-testid="restroom-details"
      className="absolute inset-x-3 bottom-3 z-10 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-card sm:left-3 sm:right-auto sm:w-96"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{restroom.name}</h2>
          <p className="text-xs text-muted-foreground">
            {isRestaurant ? `Restaurant${restroom.brand ? ` · ${restroom.brand}` : ''}` : 'Public restroom'}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <ul className="mt-3 space-y-1.5 text-sm">
        <li className="flex items-center gap-2">
          {isRestaurant ? <Utensils className="h-4 w-4" /> : <MapPin className="h-4 w-4" />}
          {GENDER_LABEL[restroom.genderType ?? 'unknown']}
        </li>
        <li className="flex items-center gap-2">
          <Accessibility className="h-4 w-4" />
          Wheelchair accessible:{' '}
          {restroom.wheelchair === 'yes' ? 'Yes' : restroom.wheelchair === 'no' ? 'No' : 'Unknown'}
        </li>
      </ul>

      {isRestaurant && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          May be for customers only.
        </p>
      )}

      <Directions
        restroom={restroom}
        userLocation={userLocation}
        travelMode={travelMode}
        onTravelModeChange={onTravelModeChange}
        route={route}
        routePending={routePending}
      />

      {showAdminInfo && (
        // Read-only: status changes go through the restrooms_set_status CLI tool.
        <p data-testid="admin-info" className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
          Admin · status <strong>{restroom.status}</strong> · id <code className="select-all">{id}</code>
        </p>
      )}
    </section>
  )
}

/** Read once: the user agent does not change during a page view. */
const APPLE_DEVICE = typeof navigator !== 'undefined' && isAppleDevice(navigator.userAgent)

function Directions({
  restroom,
  userLocation,
  travelMode,
  onTravelModeChange,
  route,
  routePending,
}: {
  restroom: Restroom
  userLocation: { latitude: number; longitude: number } | null
  travelMode: TravelMode
  onTravelModeChange: (mode: TravelMode) => void
  route: RouteSummary | { kind: 'fallback' } | null
  routePending: boolean
}) {
  const [provider, setProvider] = useState<MapsProvider>(() =>
    APPLE_DEVICE ? (loadMapsProvider() ?? 'apple') : 'google',
  )
  const meters = userLocation ? distanceMeters(userLocation, restroom) : null

  const choose = (next: MapsProvider) => {
    setProvider(next)
    saveMapsProvider(next)
  }

  const linkClass =
    'inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 py-2 text-sm font-medium text-primary-foreground hover:opacity-90'

  return (
    <div className="mt-3 border-t border-border pt-3">
      {meters !== null && (
        <div className="mb-2">
          <div
            role="group"
            aria-label="Route mode"
            data-testid="route-mode"
            className="mb-2 inline-flex rounded-md border border-border p-0.5 text-xs"
          >
            {(['walk', 'drive'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={travelMode === m}
                onClick={() => onTravelModeChange(m)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1',
                  travelMode === m ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {m === 'walk' ? <Footprints className="h-3.5 w-3.5" /> : <Car className="h-3.5 w-3.5" />}
                {m === 'walk' ? 'Walk' : 'Drive'}
              </button>
            ))}
          </div>
          {route?.kind === 'route' ? (
            <p data-testid="restroom-distance" className="text-sm">
              {formatDistance(route.distance)} · {formatDuration(route.duration)}{' '}
              {travelMode === 'walk' ? 'walk' : 'drive'}
              <span
                className="block text-xs text-muted-foreground [&_a]:underline"
                // Required by the routing service's usage policy.
                dangerouslySetInnerHTML={{
                  __html: `By ${travelMode === 'walk' ? 'walking' : 'driving'} route · ${ROUTING_ATTRIBUTION}`,
                }}
              />
            </p>
          ) : (
            <p data-testid="restroom-distance" className="text-sm">
              About {formatDistance(meters)} away
              {travelMode === 'walk' && <> · ~{formatDuration(walkingMinutes(meters) * 60)} walk</>}
              <span className="block text-xs text-muted-foreground">
                {routePending && !route ? 'Finding a route… ' : ''}Approximate, in a straight line
              </span>
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <a
          data-testid="directions-walk"
          href={directionsUrl(provider, 'walk', restroom)}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          <Footprints className="h-4 w-4" />
          Walk
        </a>
        <a
          data-testid="directions-drive"
          href={directionsUrl(provider, 'drive', restroom)}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          <Car className="h-4 w-4" />
          Drive
        </a>
        {APPLE_DEVICE && (
          <div
            role="group"
            aria-label="Maps app"
            data-testid="maps-provider-toggle"
            className="ml-auto inline-flex rounded-md border border-border p-0.5 text-xs"
          >
            {(['apple', 'google'] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={provider === p}
                onClick={() => choose(p)}
                className={cn(
                  'rounded px-1.5 py-1',
                  provider === p ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {p === 'apple' ? 'Apple Maps' : 'Google Maps'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
