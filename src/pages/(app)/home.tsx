/**
 * Home — full-screen map of nearby restrooms.
 *
 * Restrooms come from the `restrooms` collection via useQuery; the server only
 * ships rows the caller may read (active ones, for everyone but admins). The
 * map asks /api/restrooms/seed to fill in OpenStreetMap data for the grid
 * cells in view whenever it settles at a useful zoom.
 *
 * The visitor's location is GPS (when allowed) or a point they set on the map;
 * either one drives the user dot, distances, and the closest-restroom pick.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MapLibreMap,
  Marker as MapLibreMarker,
} from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { getAuthToken, useAuthProfileReady, useQuery } from 'deepspace'
import { Accessibility, Car, Footprints, Info, MapPin, Utensils, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LocationControl } from '../../components/LocationControl'
import {
  directionsUrl,
  distanceMeters,
  formatDistance,
  isAppleDevice,
  loadMapsProvider,
  saveMapsProvider,
  walkingMinutes,
  type MapsProvider,
} from '../../lib/directions'
import {
  cellsInView,
  DEFAULT_CENTER,
  MIN_SEED_ZOOM,
  US_MAX_BOUNDS,
} from '../../lib/us-geo'
import type { Point } from '../../lib/location'
import { isInUSOutline } from '../../lib/us-outline'
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
const AUTO_SELECT_WAIT_MS = 5000
/** Seeding waits this long for the first location answer before using the default city. */
const SEED_LOCATION_WAIT_MS = 6000
/** The selected marker's halo when not pulsing (reduced motion). */
const HALO_REST = { radius: 24, opacity: 0.5 }
/** Hit area around a click, so small markers are easy to tap. */
const CLICK_TOLERANCE_PX = 8
const MARKER_LAYERS = ['restroom-selected', 'restrooms']
const markerColor = [
  'case',
  ['!=', ['get', 'status'], 'active'],
  UNAVAILABLE_COLOR,
  ['match', ['get', 'kind'], 'restaurant', KIND_COLOR.restaurant, KIND_COLOR.public],
] as ExpressionSpecification

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
  const { records, status: recordsStatus } = useQuery<Restroom>('restrooms')

  const [genders, setGenders] = useState<Set<GenderType>>(() => new Set(GENDER_TYPES))
  const [kinds, setKinds] = useState<Set<RestroomKind>>(() => new Set(RESTROOM_KINDS))
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tooFarOut, setTooFarOut] = useState(false)
  const loc = useUserLocation()
  const userLocation = loc.location
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [seedState, setSeedState] = useState<'idle' | 'loading' | 'error'>('idle')
  // Completed seeding passes; auto-select waits for one that started after the
  // location became known (or a timeout), so nearby rows have arrived.
  const [seedPasses, setSeedPasses] = useState(0)
  const [autoSelectWait, setAutoSelectWait] = useState<{
    key: string
    pass: number
    expired: boolean
  } | null>(null)
  // Once per page load: set after the auto-selection, or when the user
  // selects, closes, pans, or filters while their location is known.
  const autoSelectDone = useRef(false)
  const locationRef = useRef<Point | null>(userLocation)
  const seedPassesRef = useRef(0)
  const pickingRef = useRef(false)
  useEffect(() => {
    locationRef.current = userLocation
    seedPassesRef.current = seedPasses
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

  const visible = useMemo(
    () =>
      records.filter((r) => kinds.has(r.data.kind) && genders.has(r.data.genderType ?? 'unknown')),
    [records, kinds, genders],
  )
  const selected = records.find((r) => r.recordId === selectedId) ?? null

  /** User interaction ends the auto-select window, once a location is known. */
  const markInteraction = useCallback(() => {
    if (locationRef.current) autoSelectDone.current = true
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
    const passDone = () => setSeedPasses((n) => n + 1)
    if (map.getZoom() < MIN_SEED_ZOOM) {
      setTooFarOut(true)
      passDone()
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
      passDone()
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
    passDone()
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
        attributionControl: { compact: true },
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
            loc.setManual({ latitude: lat, longitude: lng })
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
  }, [seedView, select, markInteraction])

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

  // Push filtered records into the map source.
  useEffect(() => {
    const source = mapReady ? mapRef.current?.getSource<GeoJSONSource>('restrooms') : undefined
    source?.setData({
      type: 'FeatureCollection',
      features: visible.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.data.longitude, r.data.latitude] },
        properties: { id: r.recordId, kind: r.data.kind, status: r.data.status },
      })),
    })
  }, [visible, mapReady])

  // Show the selection: base layer without it, halo and large dot with it.
  useEffect(() => {
    const map = mapReady ? mapRef.current : null
    if (!map) return
    const id = selectedId ?? ''
    map.setFilter('restrooms', ['!=', ['get', 'id'], id])
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
  }, [selectedId, mapReady])

  // Auto-select the nearest matching restroom, once per page load, when a
  // location (GPS or set on the map) becomes known. It waits for a seeding
  // pass that started afterwards, or a few seconds, so nearby rows are in.
  const locationKey = userLocation ? `${userLocation.latitude},${userLocation.longitude}` : null
  useEffect(() => {
    if (!locationKey || autoSelectDone.current) return
    setAutoSelectWait({ key: locationKey, pass: seedPassesRef.current, expired: false })
    const timer = setTimeout(
      () => setAutoSelectWait((w) => (w && w.key === locationKey ? { ...w, expired: true } : w)),
      AUTO_SELECT_WAIT_MS,
    )
    return () => clearTimeout(timer)
  }, [locationKey])

  useEffect(() => {
    if (autoSelectDone.current || !userLocation || !mapReady || selectedId) return
    if (recordsStatus !== 'ready' || visible.length === 0) return
    const wait = autoSelectWait
    if (!wait || wait.key !== locationKey) return
    const seeded = seedState !== 'loading' && (seedPasses > wait.pass || loc.source === 'manual')
    if (!seeded && !wait.expired) return
    autoSelectDone.current = true
    let nearest = visible[0]
    let best = Infinity
    for (const r of visible) {
      const d = distanceMeters(userLocation, r.data)
      if (d < best) {
        best = d
        nearest = r
      }
    }
    setSelectedId(nearest.recordId)
    const map = mapRef.current
    const at: [number, number] = [nearest.data.longitude, nearest.data.latitude]
    if (map && !map.getBounds().contains(at)) map.easeTo({ center: at })
  }, [
    userLocation,
    locationKey,
    loc.source,
    mapReady,
    selectedId,
    recordsStatus,
    visible,
    autoSelectWait,
    seedState,
    seedPasses,
  ])

  // Escape closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (pickingRef.current) {
        setPicking(false)
        setPickError(null)
      } else select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

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
      {/* maplibre's unlayered `.maplibregl-map { position: relative }` beats
          Tailwind's layered utilities, so the map element itself must not rely
          on `absolute inset-0` for its size — the wrapper provides it. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" data-testid="restroom-map" />
      </div>

      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col gap-2 sm:right-auto sm:w-80">
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
            {visible.length} shown
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
          onCancelPick={() => {
            setPickError(null)
            setPicking(false)
          }}
          onRecenter={() => {
            if (loc.gps) mapRef.current?.easeTo({ center: [loc.gps.longitude, loc.gps.latitude] })
          }}
        />
      </div>

      {selected && (
        <RestroomDetails
          id={selected.recordId}
          restroom={selected.data}
          userLocation={userLocation}
          canToggleStatus={isAdmin && import.meta.env.DEV}
          onClose={() => select(null)}
        />
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
  canToggleStatus,
  onClose,
}: {
  id: string
  restroom: Restroom
  userLocation: { latitude: number; longitude: number } | null
  canToggleStatus: boolean
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isRestaurant = restroom.kind === 'restaurant'

  const setStatus = async (status: 'active' | 'unavailable') => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/restrooms/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${(await getAuthToken()) ?? ''}`,
        },
        body: JSON.stringify({ status }),
      })
      if (!res.ok) setError(`Status change refused (${res.status})`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="restroom-details"
      className="absolute inset-x-3 bottom-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-card sm:left-3 sm:right-auto sm:w-96"
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

      <Directions restroom={restroom} userLocation={userLocation} />

      {canToggleStatus && (
        <div className="mt-3 border-t border-border pt-3 text-xs">
          <p className="mb-2 text-muted-foreground">
            Dev only · status: <strong>{restroom.status}</strong>
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setStatus(restroom.status === 'active' ? 'unavailable' : 'active')}
            className="rounded-md border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
          >
            {restroom.status === 'active' ? 'Mark unavailable' : 'Mark active'}
          </button>
          {error && <p className="mt-2 text-destructive">{error}</p>}
        </div>
      )}
    </section>
  )
}

/** Read once: the user agent does not change during a page view. */
const APPLE_DEVICE = typeof navigator !== 'undefined' && isAppleDevice(navigator.userAgent)

function Directions({
  restroom,
  userLocation,
}: {
  restroom: Restroom
  userLocation: { latitude: number; longitude: number } | null
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
        <p data-testid="restroom-distance" className="mb-2 text-sm">
          About {formatDistance(meters)} away · ~{walkingMinutes(meters)} min walk
          <span className="block text-xs text-muted-foreground">
            Approximate, in a straight line
          </span>
        </p>
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
