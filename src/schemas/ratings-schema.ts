/**
 * Ratings - Schema
 *
 * `restroom_ratings`: one row per user per restroom (record id
 * `${restroomId}~${userId}`, also enforced by uniqueOn). Only the
 * `rateRestroom` server action writes it; each user can read only their own
 * rows. The uniqueOn's index (restroomId first) is what makes the action's
 * "all ratings for this restroom" query an index lookup.
 *
 * `restroom_scores`: the per-restroom summary (record id = restroomId) —
 * sample score, rating count and sum, and the effective score. Server-only:
 * no role reads it, scores reach clients through POST /api/restrooms/scores,
 * which answers only for restrooms the caller can see. `cellKey` lets the
 * backfill read a whole cell's summaries in one query (index via uniqueOn).
 */

import type { CollectionSchema } from 'deepspace/schema'

export interface RestroomRating {
  restroomId: string
  userId: string
  stars: number
  updatedAt: number
}

export interface RestroomScore {
  restroomId: string
  cellKey: string
  sampleScore: number
  ratingCount: number
  ratingSum: number
  /** effectiveScore(sampleScore, ratingCount, ratingSum) */
  score: number
}

export function ratingRecordId(restroomId: string, userId: string): string {
  return `${restroomId}~${userId}`
}

const NO_WRITES = { create: false, update: false, delete: false } as const
const NO_ACCESS = { read: false, ...NO_WRITES } as const

export const restroomRatingsSchema: CollectionSchema = {
  name: 'restroom_ratings',
  columns: [
    { name: 'restroomId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'userId', storage: 'text', interpretation: 'plain', required: true, userBound: true },
    { name: 'stars', storage: 'number', interpretation: 'plain', required: true },
    { name: 'updatedAt', storage: 'number', interpretation: 'plain', required: true },
  ],
  uniqueOn: ['restroomId', 'userId'],
  ownerField: 'userId',
  permissions: {
    '*': NO_ACCESS,
    viewer: { read: 'own', ...NO_WRITES },
    member: { read: 'own', ...NO_WRITES },
    admin: { read: 'own', ...NO_WRITES },
  },
}

export const restroomScoresSchema: CollectionSchema = {
  name: 'restroom_scores',
  columns: [
    { name: 'restroomId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'cellKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'sampleScore', storage: 'number', interpretation: 'plain', required: true },
    { name: 'ratingCount', storage: 'number', interpretation: 'plain', required: true },
    { name: 'ratingSum', storage: 'number', interpretation: 'plain', required: true },
    { name: 'score', storage: 'number', interpretation: 'plain', required: true },
  ],
  uniqueOn: ['cellKey', 'restroomId'],
  permissions: {
    '*': NO_ACCESS,
    viewer: NO_ACCESS,
    member: NO_ACCESS,
    admin: NO_ACCESS,
  },
}
