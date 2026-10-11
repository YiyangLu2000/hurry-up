/**
 * Location status chip and its panel on the map.
 *
 * The chip names the state; the panel offers the one useful action for it
 * (ask, explain how to unblock, or recenter), plus setting a location by
 * tapping the map.
 */

import { useState } from 'react'
import { Locate, LocateFixed, LocateOff, MapPinned, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { blockedLocationSteps } from '../lib/location'
import type { UserLocation } from '../lib/use-user-location'

type Props = {
  loc: UserLocation
  picking: boolean
  pickError: string | null
  onStartPick: () => void
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

export function LocationControl({ loc, picking, pickError, onStartPick, onCancelPick, onRecenter }: Props) {
  const [open, setOpen] = useState(false)
  const { text, Icon } = chipLabel(loc)
  // Picking needs the map clear; the panel stays closed afterwards.
  const startPick = () => {
    setOpen(false)
    onStartPick()
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
          className="w-full rounded-lg border border-border bg-card p-3 text-sm text-card-foreground shadow-card"
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

          <div className="mt-3 border-t border-border pt-3">
            {loc.manual ? (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  Using a location you set on the map{loc.gps ? ' instead of your device location' : ''}.
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={startPick} className={secondaryClass}>
                    Move it
                  </button>
                  <button type="button" data-testid="clear-manual" onClick={loc.clearManual} className={secondaryClass}>
                    Clear
                  </button>
                </div>
              </>
            ) : (
              <button type="button" data-testid="start-pick" onClick={startPick} className={secondaryClass}>
                Set my location on the map
              </button>
            )}
          </div>
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
