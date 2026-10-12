/**
 * A number that goes up every `intervalMs` while the tab is visible, and when
 * the tab comes back into view (visibility or window focus) — at most once
 * per `minGapMs`. Consumers re-fetch whenever it changes.
 */

import { useEffect, useState } from 'react'

export const REFRESH_INTERVAL_MS = 2 * 60 * 1000
const MIN_GAP_MS = 10 * 1000

export function useRefreshNonce(intervalMs = REFRESH_INTERVAL_MS, minGapMs = MIN_GAP_MS): number {
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let last = Date.now()
    const bump = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < minGapMs) return
      last = Date.now()
      setNonce((n) => n + 1)
    }
    const timer = setInterval(bump, intervalMs)
    document.addEventListener('visibilitychange', bump)
    window.addEventListener('focus', bump)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', bump)
      window.removeEventListener('focus', bump)
    }
  }, [intervalMs, minGapMs])
  return nonce
}
