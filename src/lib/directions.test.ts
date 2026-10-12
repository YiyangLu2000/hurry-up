import { describe, expect, it } from 'vitest'
import { directionsUrl, distanceMeters, formatDistance, isAppleDevice, walkingMinutes } from './directions'

const to = { latitude: 34.0522, longitude: -118.2437 }

describe('directionsUrl', () => {
  it('builds Apple Maps links with only a destination', () => {
    expect(directionsUrl('apple', 'walk', to)).toBe(
      'https://maps.apple.com/?daddr=34.052200,-118.243700&dirflg=w',
    )
    expect(directionsUrl('apple', 'drive', to)).toBe(
      'https://maps.apple.com/?daddr=34.052200,-118.243700&dirflg=d',
    )
  })

  it('builds Google Maps links with only a destination', () => {
    expect(directionsUrl('google', 'walk', to)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=34.052200,-118.243700&travelmode=walking',
    )
    expect(directionsUrl('google', 'drive', to)).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=34.052200,-118.243700&travelmode=driving',
    )
  })
})

describe('isAppleDevice', () => {
  it('matches iPhone, iPadOS, and Mac user agents', () => {
    expect(isAppleDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true)
    expect(isAppleDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
  })

  it('does not match Android or Windows', () => {
    expect(isAppleDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9)')).toBe(false)
    expect(isAppleDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false)
  })
})

describe('distance', () => {
  it('measures straight-line distance', () => {
    // 0.01° of latitude is about 1112 m.
    expect(distanceMeters(to, { ...to, latitude: to.latitude + 0.01 })).toBeCloseTo(1112, -1)
  })

  it('formats feet below a tenth of a mile, miles above', () => {
    expect(formatDistance(50)).toBe('160 ft')
    expect(formatDistance(1112)).toBe('0.7 mi')
    expect(formatDistance(30_000)).toBe('19 mi')
  })

  it('estimates walking time at 80 m per minute, at least one minute', () => {
    expect(walkingMinutes(1112)).toBe(14)
    expect(walkingMinutes(20)).toBe(1)
  })
})

describe('directionsUrl with a start point (a location the visitor set)', () => {
  const from = { latitude: 47.6505, longitude: -122.3205 }

  it('starts Apple Maps there (saddr)', () => {
    expect(directionsUrl('apple', 'walk', to, from)).toBe(
      'https://maps.apple.com/?saddr=47.650500,-122.320500&daddr=34.052200,-118.243700&dirflg=w',
    )
  })

  it('starts Google Maps there (origin)', () => {
    expect(directionsUrl('google', 'drive', to, from)).toBe(
      'https://www.google.com/maps/dir/?api=1&origin=47.650500,-122.320500&destination=34.052200,-118.243700&travelmode=driving',
    )
  })

  it('leaves the start to the device when there is none', () => {
    expect(directionsUrl('apple', 'walk', to, null)).toBe(directionsUrl('apple', 'walk', to))
    expect(directionsUrl('google', 'walk', to, null)).not.toContain('origin=')
  })
})
