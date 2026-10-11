/**
 * Location status chip and its panel on the map.
 *
 * The chip names the state; the panel offers the one useful action for it
 * (ask, explain how to unblock, or recenter), plus setting a location by
 * tapping the map.
 */

import { useState, type FormEvent } from 'react'
import { Locate, LocateFixed, LocateOff, MapPinned, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { blockedLocationSteps } from '../lib/location'
import { GEOCODER_ATTRIBUTION, parseCoordinates, searchPlaces, type Place } from '../lib/geocode'
import { isInUSOutline } from '../lib/us-outline'
import type { UserLocation } from '../lib/use-user-location'

type Props = {
  loc: UserLocation
  picking: boolean
  pickError: string | null
  onStartPick: () => void
  /** A typed place or coordinates was chosen (already checked to be in the US). */
  onChoosePlace: (place: Place) => void
  onCancelPick: () => void
  onRecenter: () => void
}

function chipLabel(loc: UserLocation): { text: string; Icon: typeof Locate } {
  if (loc.source === 'manual') return { text: 'Location set on map', Icon: MapPinned }
  if (loc.permission === 'denied') return { text: 'Location off', Icon: LocateOff }
  if (loc.permission === 'granted') {
    if (loc.gpsStatus === 'ok') return { text: 'Using your location', Icon: LocateFixed }
    if (loc.gpsStatus === 'locating') return { text: 'Finding your location…', Icon: Locate }
    if (loc.gpsStatus === 'outside-us') return { text: 'Outside the US', Icon: LocateOff }
    return { text: 'Location unavailable', Icon: LocateOff }
  }
  if (loc.gpsStatus === 'ok') return { text: 'Using your location', Icon: LocateFixed }
  return { text: 'Location not set', Icon: Locate }
}

const buttonClass =
  'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50'
const secondaryClass =
  'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted'

export function LocationControl({
  loc,
  picking,
  pickError,
  onStartPick,
  onChoosePlace,
  onCancelPick,
  onRecenter,
}: Props) {
  const [open, setOpen] = useState(false)
  const { text, Icon } = chipLabel(loc)
  // Picking needs the map clear; the panel stays closed afterwards.
  const startPick = () => {
    setOpen(false)
    onStartPick()
  }
  const choosePlace = (place: Place) => {
    setOpen(false)
    onChoosePlace(place)
  }

  if (picking) {
    return (
      <div
        data-testid="pick-banner"
        className="pointer-events-auto rounded-md bg-card/95 px-3 py-2 text-xs text-card-foreground shadow-card"
      >
        <div className="flex items-center justify-between gap-3">
          <span>Tap the map where you are.</span>
          <button type="button" onClick={onCancelPick} className="font-medium underline underline-offset-2">
            Cancel
          </button>
        </div>
        {pickError && <p className="mt-1 text-destructive">{pickError}</p>}
      </div>
    )
  }

  return (
    <div className="pointer-events-auto flex flex-col items-start gap-2">
      <button
        type="button"
        data-testid="location-chip"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs font-medium text-card-foreground shadow-card backdrop-blur',
          loc.permission === 'denied' && loc.source !== 'manual' && 'text-muted-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
        {text}
      </button>

      {open && (
        <section
          data-testid="location-panel"
          className="max-h-[60vh] w-full overflow-y-auto rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow-card"
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <h2 className="text-sm font-semibold">Your location</h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close location panel"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <PermissionSection loc={loc} onRecenter={onRecenter} />

          <ManualSection loc={loc} onStartPick={startPick} onChoosePlace={choosePlace} />
        </section>
      )}
    </div>
  )
}

function PermissionSection({ loc, onRecenter }: { loc: UserLocation; onRecenter: () => void }) {
  if (loc.permission === 'denied') {
    const steps = blockedLocationSteps(navigator.userAgent, navigator.maxTouchPoints)
    return (
      <div data-testid="location-blocked">
        <p className="mb-2 text-xs">Your browser is blocking location for this site. To turn it back on:</p>
        <ol className="mb-2 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="mb-2 text-xs text-muted-foreground">
          Once it&apos;s allowed, the map picks up your location automatically.
        </p>
        {/* Browsers that don't report permission changes need a manual nudge. */}
        <button type="button" onClick={loc.request} className={secondaryClass}>
          Check again
        </button>
      </div>
    )
  }

  if (loc.permission === 'granted' || loc.gpsStatus === 'ok') {
    return (
      <div data-testid="location-allowed">
        <p className="mb-2 text-xs">
          {loc.gpsStatus === 'ok'
            ? 'Location is on.'
            : loc.gpsStatus === 'locating'
              ? 'Location is on. Finding you…'
              : loc.gpsStatus === 'outside-us'
                ? 'Location is on, but you appear to be outside the US, so it isn’t used.'
                : 'Location is allowed, but your device couldn’t provide it.'}
        </p>
        {loc.gpsStatus === 'ok' ? (
          <button type="button" data-testid="recenter" onClick={onRecenter} className={buttonClass}>
            Recenter on me
          </button>
        ) : (
          loc.gpsStatus !== 'locating' && (
            <button type="button" onClick={loc.request} className={secondaryClass}>
              Try again
            </button>
          )
        )}
      </div>
    )
  }

  return (
    <div data-testid="location-prompt">
      <p className="mb-2 text-xs text-muted-foreground">
        Share your location to find the closest restroom and see distances.
      </p>
      <button
        type="button"
        data-testid="use-my-location"
        onClick={loc.request}
        disabled={loc.gpsStatus === 'locating'}
        className={buttonClass}
      >
        Use my location
      </button>
    </div>
  )
}

/**
 * Setting a location yourself, available whatever the permission state:
 * type an address, place, or "lat, lng", or tap the map.
 */
function ManualSection({
  loc,
  onStartPick,
  onChoosePlace,
}: {
  loc: UserLocation
  onStartPick: () => void
  onChoosePlace: (place: Place) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Place[] | null>(null)
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // One request per submit (never as-you-type), per the geocoder's policy.
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const text = query.trim()
    if (!text || status === 'searching') return
    setMessage(null)
    setResults(null)
    const coords = parseCoordinates(text)
    if (coords) {
      if (isInUSOutline(coords.latitude, coords.longitude)) {
        onChoosePlace({ ...coords, label: `${coords.latitude}, ${coords.longitude}` })
      } else {
        setMessage('Those coordinates are outside the US.')
      }
      return
    }
    setStatus('searching')
    try {
      const places = await searchPlaces(text)
      setStatus('idle')
      if (places.length === 0) setMessage('No US places found. Try adding a city or ZIP code.')
      else setResults(places)
    } catch {
      setStatus('error')
      setMessage('Search is unavailable right now. You can tap the map instead.')
    }
  }

  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-2 text-xs font-medium">
        {loc.permission === 'granted' && loc.gpsStatus === 'ok'
          ? 'Somewhere else? Set your location yourself'
          : 'Set your location yourself'}
      </p>

      {loc.manual && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs">
          <span data-testid="manual-label" className="min-w-0">
            Using {loc.manual.label ? <strong className="break-words">{loc.manual.label}</strong> : 'a point you set on the map'}
            {loc.gps ? ' instead of your device location' : ''}.
          </span>
          <button
            type="button"
            data-testid="clear-manual"
            onClick={loc.clearManual}
            className="shrink-0 font-medium underline underline-offset-2"
          >
            Clear
          </button>
        </div>
      )}

      <form onSubmit={submit} className="flex gap-2" role="search">
        <input
          data-testid="place-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Address, place, or lat, lng"
          aria-label="Type your location"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="submit"
          data-testid="place-search"
          disabled={!query.trim() || status === 'searching'}
          className={cn(secondaryClass, 'inline-flex items-center gap-1 px-2.5')}
        >
          <Search className="h-3.5 w-3.5" />
          {status === 'searching' ? 'Searching…' : 'Search'}
        </button>
      </form>

      {message && (
        <p data-testid="place-message" className="mt-2 text-xs text-muted-foreground">
          {message}
        </p>
      )}

      {results && (
        <div className="mt-2">
          <ul data-testid="place-results" className="max-h-40 space-y-1 overflow-y-auto">
            {results.map((p) => (
              <li key={`${p.latitude},${p.longitude}`}>
                <button
                  type="button"
                  onClick={() => onChoosePlace(p)}
                  className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                >
                  {p.label}
                </button>
              </li>
            ))}
          </ul>
          <p
            className="mt-1 text-[10px] text-muted-foreground [&_a]:underline"
            // Attribution required by the geocoder's usage policy.
            dangerouslySetInnerHTML={{ __html: GEOCODER_ATTRIBUTION }}
          />
        </div>
      )}

      <button type="button" data-testid="start-pick" onClick={onStartPick} className={cn(secondaryClass, 'mt-2')}>
        {loc.manual ? 'Tap the map instead' : 'Tap the map where you are'}
      </button>
    </div>
  )
}
