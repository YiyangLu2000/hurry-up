/**
 * Restroom scores and the visibility they imply. Pure functions, shared by
 * the server (which stores both) and the client (which only displays them).
 *
 * - A restroom with no ratings has a sample score derived from its record id:
 *   one of 3.0, 3.1, … 4.2, picked by a hash, so it never changes.
 * - Once it has ratings, the average (rounded to 0.1) replaces the sample.
 * - Visibility compares the ROUNDED score with 4.0, so what the panel shows
 *   and who may see the restroom always agree (an average of 4.04 shows "4.0"
 *   and stays public).
 */

import type { RestroomStatus } from '../schemas/restrooms-schema.js'

export type Visibility = 'public' | 'premium' | 'hidden'

export const SAMPLE_MIN = 3.0
export const SAMPLE_MAX = 4.2
/** Scores above this are premium (members only). */
export const PREMIUM_ABOVE = 4.0

/** Number of 0.1 steps from SAMPLE_MIN to SAMPLE_MAX inclusive (13). */
const SAMPLE_STEPS = Math.round((SAMPLE_MAX - SAMPLE_MIN) * 10) + 1

/** 32-bit FNV-1a: stable across runtimes, unlike anything seeded by time. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function roundScore(value: number): number {
  return Math.round(value * 10) / 10
}

export function sampleScore(recordId: string): number {
  return roundScore(SAMPLE_MIN + (fnv1a(recordId) % SAMPLE_STEPS) / 10)
}

/** The score shown and gated on: the rounded average once rated, else the sample. */
export function effectiveScore(sample: number, ratingCount: number, ratingSum: number): number {
  return ratingCount > 0 ? roundScore(ratingSum / ratingCount) : sample
}

export function visibilityFor(status: RestroomStatus | undefined, score: number): Visibility {
  if (status !== 'active') return 'hidden'
  return roundScore(score) > PREMIUM_ABOVE ? 'premium' : 'public'
}

/** Whole stars 1 to 5, as a number; everything else (0, 6, 3.5, "4", null) is refused. */
export function isValidStars(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
}
