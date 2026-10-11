/**
 * Location helpers: browser-specific steps for re-enabling a blocked location
 * permission, and session storage for a location the user set on the map.
 */

import { isInUSOutline } from './us-outline'

export type Point = { latitude: number; longitude: number }

export type BrowserFamily =
  | 'ios'
  | 'android-chrome'
  | 'chrome'
  | 'edge'
  | 'firefox'
  | 'safari'
  | 'other'

/**
 * `maxTouchPoints` tells an iPad (which reports a Mac user agent) from a Mac.
 * Every iOS browser shares iOS's location settings, so iOS is checked first.
 */
export function detectBrowser(userAgent: string, maxTouchPoints = 0): BrowserFamily {
  const ua = userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Android/.test(ua) && /Chrome\//.test(ua)) return 'android-chrome'
  if (/Chrome\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

/** The app in iOS Settings whose location access matters for this browser. */
function iosSettingsApp(userAgent: string): string {
  if (/CriOS\//.test(userAgent)) return 'Chrome'
  if (/FxiOS\//.test(userAgent)) return 'Firefox'
  if (/EdgiOS\//.test(userAgent)) return 'Edge'
  return 'Safari Websites'
}

/** Short, ordered steps to unblock location for this site. */
export function blockedLocationSteps(userAgent: string, maxTouchPoints = 0): string[] {
  switch (detectBrowser(userAgent, maxTouchPoints)) {
    case 'ios':
      return [
        'Open the Settings app, then Privacy & Security → Location Services, and make sure it is on.',
        `In the same list, tap ${iosSettingsApp(userAgent)} and choose “While Using the App”.`,
        'Come back here and tap “Check again”. If it still says off, reload the page and tap Allow.',
      ]
    case 'android-chrome':
      return [
        'Tap the icon to the left of the address bar, then Permissions.',
        'Turn Location on (Allow).',
      ]
    case 'chrome':
      return [
        'Click the site-controls icon to the left of the address bar.',
        'Turn Location on, or open Site settings and set Location to Allow.',
      ]
    case 'edge':
      return [
        'Click the lock icon to the left of the address bar.',
        'Under Permissions for this site, set Location to Allow.',
      ]
    case 'firefox':
      return [
        'Click the crossed-out location icon in the address bar.',
        'Clear the “Blocked” setting, then click “Use my location” and choose Allow.',
      ]
    case 'safari':
      return [
        'In the menu bar, choose Safari → Settings… → Websites → Location.',
        'Set this website to Allow.',
        'If that does not help: System Settings → Privacy & Security → Location Services → turn on Safari.',
      ]
    default:
      return ['Open your browser’s site settings for this page and allow Location.']
  }
}

const MANUAL_KEY = 'hurry-up:manual-location'

/** The location set on the map this session; null when absent or unusable. */
export function loadManualLocation(): Point | null {
  try {
    const raw = sessionStorage.getItem(MANUAL_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<Point>
    if (typeof p.latitude !== 'number' || typeof p.longitude !== 'number') return null
    return isInUSOutline(p.latitude, p.longitude) ? { latitude: p.latitude, longitude: p.longitude } : null
  } catch {
    return null
  }
}

export function saveManualLocation(p: Point | null): void {
  try {
    if (p) sessionStorage.setItem(MANUAL_KEY, JSON.stringify(p))
    else sessionStorage.removeItem(MANUAL_KEY)
  } catch {
    // Not persisted; the location still applies for this page view.
  }
}
