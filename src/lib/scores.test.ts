import { describe, expect, it } from 'vitest'
import { effectiveScore, isValidStars, PREMIUM_ABOVE, SAMPLE_MAX, SAMPLE_MIN, sampleScore, visibilityFor } from './scores'

describe('isValidStars', () => {
  it.each([1, 2, 3, 4, 5])('accepts %s', (v) => expect(isValidStars(v)).toBe(true))
  it.each([0, 6, 3.5, -1, Number.NaN, Infinity, '4', '', null, undefined, true, [4], { stars: 4 }])(
    'rejects %j',
    (v) => expect(isValidStars(v)).toBe(false),
  )
})

describe('sampleScore', () => {
  const ids = Array.from({ length: 5000 }, (_, i) => `osm-node-${1000 + i * 7}`)

  it('is stable for a record id (pinned values guard against a changed hash)', () => {
    expect(sampleScore('osm-node-42')).toBe(sampleScore('osm-node-42'))
    expect(ids.slice(0, 5).map(sampleScore)).toEqual(ids.slice(0, 5).map(sampleScore))
    expect([sampleScore('osm-node-42'), sampleScore('osm-way-123456'), sampleScore('osm-node-9876543210')]).toMatchInlineSnapshot(`
      [
        3.6,
        4.1,
        4.1,
      ]
    `)
  })

  it('stays within 3.0 to 4.2 in 0.1 steps', () => {
    for (const s of ids.map(sampleScore)) {
      expect(s).toBeGreaterThanOrEqual(SAMPLE_MIN)
      expect(s).toBeLessThanOrEqual(SAMPLE_MAX)
      expect(Math.round(s * 10)).toBeCloseTo(s * 10, 9)
    }
  })

  it('uses the whole range, with about 2 in 13 above 4.0', () => {
    const scores = ids.map(sampleScore)
    expect(new Set(scores).size).toBe(13)
    const premium = scores.filter((s) => s > PREMIUM_ABOVE).length / scores.length
    expect(premium).toBeGreaterThan(0.12)
    expect(premium).toBeLessThan(0.19)
  })
})

describe('effectiveScore', () => {
  it('uses the sample until there are ratings, then the rounded average', () => {
    expect(effectiveScore(3.7, 0, 0)).toBe(3.7)
    expect(effectiveScore(3.7, 2, 9)).toBe(4.5)
    expect(effectiveScore(3.7, 3, 13)).toBe(4.3)
  })
})

describe('visibilityFor', () => {
  it('hides unavailable and pending restrooms whatever their score', () => {
    expect(visibilityFor('unavailable', 3)).toBe('hidden')
    expect(visibilityFor('pending', 4.9)).toBe('hidden')
    expect(visibilityFor(undefined, 3)).toBe('hidden')
  })

  it('makes active restrooms premium only above 4.0, on the rounded score', () => {
    expect(visibilityFor('active', 4.0)).toBe('public')
    expect(visibilityFor('active', 4.04)).toBe('public')
    expect(visibilityFor('active', 4.05)).toBe('premium')
    expect(visibilityFor('active', 4.1)).toBe('premium')
    expect(visibilityFor('active', 1)).toBe('public')
  })
})
