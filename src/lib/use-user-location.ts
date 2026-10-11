/**
 * The visitor's location: browser permission state (live where the
 * Permissions API supports it), the GPS fix, and an optional location the
 * user set on the map. A manual location takes precedence over GPS.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isInUSOutline } from './us-outline'
import { loadManualLocation, saveManualLocation, type Point } from './location'

/** 'unknown': the browser cannot report permission and we have not asked yet. */
export type LocationPermission = 'granted' | 'denied' | 'prompt' | 'unknown'
export type GpsStatus = 'idle' | 'locating' | 'ok' | 'outside-us' | 'unavailable'

const PERMISSION_DENIED = 1

export function useUserLocation() {
  const [permission, setPermission] = useState<LocationPermission>('unknown')
  const [gps, setGps] = useState<Point | null>(null)
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('idle')
  const [manual, setManualState] = useState<Point | null>(() => loadManualLocation())
  // The first location attempt has finished (or there will not be one).
  const [settled, setSettled] = useState(false)
  const statusRef = useRef<PermissionStatus | null>(null)

  /**
   * Ask for a position. Shows the browser prompt when permission is 'prompt'.
   * Where the Permissions API exists its state is the truth; otherwise the
   * result of this request is the only signal (success → allowed, a
   * permission error → blocked).
   */
  const request = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setGpsStatus('unavailable')
      setSettled(true)
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const p = { latitude: coords.latitude, longitude: coords.longitude }
        const inUS = isInUSOutline(p.latitude, p.longitude)
        setGps(inUS ? p : null)
        setGpsStatus(inUS ? 'ok' : 'outside-us')
        setPermission(statusRef.current?.state ?? 'granted')
        setSettled(true)
      },
      (err) => {
        const denied = err.code === PERMISSION_DENIED
        setGps(null)
        setGpsStatus(denied ? 'idle' : 'unavailable')
        if (statusRef.current) setPermission(statusRef.current.state)
        else if (denied) setPermission('denied')
        setSettled(true)
      },
      { timeout: 10_000, maximumAge: 5 * 60_000 },
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    let status: PermissionStatus | null = null
    const onChange = () => {
      if (!status) return
      setPermission(status.state)
      // Allowed after being blocked or unasked: pick the location up now.
      if (status.state === 'granted') request()
      else {
        setGps(null)
        setGpsStatus('idle')
      }
    }
    void (async () => {
      try {
        status = (await navigator.permissions?.query({ name: 'geolocation' })) ?? null
      } catch {
        status = null // Older browsers: no geolocation permission query.
      }
      if (cancelled) return
      statusRef.current = status
      if (status) {
        setPermission(status.state)
        status.addEventListener('change', onChange)
      }
      // A blocked permission cannot prompt; anything else asks once on load.
      if (status?.state === 'denied') setSettled(true)
      else request()
    })()
    return () => {
      cancelled = true
      status?.removeEventListener('change', onChange)
    }
  }, [request])

  const setManual = useCallback((p: Point) => {
    setManualState(p)
    saveManualLocation(p)
  }, [])

  const clearManual = useCallback(() => {
    setManualState(null)
    saveManualLocation(null)
  }, [])

  const location = manual ?? gps
  const source: 'manual' | 'gps' | null = manual ? 'manual' : gps ? 'gps' : null
  return {
    permission,
    gps,
    gpsStatus,
    manual,
    location,
    source,
    settled,
    request,
    setManual,
    clearManual,
  }
}

export type UserLocation = ReturnType<typeof useUserLocation>
