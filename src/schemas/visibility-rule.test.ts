/**
 * The collection read rules, checked with the SDK's own permission function
 * (the one RecordRoom applies to queries and broadcasts). The wire-level
 * check with real sockets is tests/ratings.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { canRead, ROLE_ANONYMOUS } from 'deepspace/worker'
import { restroomRatingsSchema, restroomScoresSchema } from './ratings-schema'
import { restroomsSchema } from './restrooms-schema'

const SEEDER = 'system:osm-seeder'
const row = (visibility: string | undefined, status = 'active') => ({
  recordId: 'osm-node-1',
  createdBy: SEEDER,
  data: { name: 'x', status, visibility, cellKey: 'c' },
})
const NON_MEMBER_ROLES = [ROLE_ANONYMOUS, '*', 'viewer', 'member']

describe('restrooms read rule', () => {
  it.each(NON_MEMBER_ROLES)('lets %s read public rows only', (role) => {
    expect(canRead(restroomsSchema, role, row('public'), 'user-1')).toBe(true)
    expect(canRead(restroomsSchema, role, row('premium'), 'user-1')).toBe(false)
    expect(canRead(restroomsSchema, role, row('hidden', 'unavailable'), 'user-1')).toBe(false)
    expect(canRead(restroomsSchema, role, row('hidden', 'pending'), 'user-1')).toBe(false)
    // A row the backfill has not reached yet is not readable either.
    expect(canRead(restroomsSchema, role, row(undefined), 'user-1')).toBe(false)
  })

  it('lets admins read every row', () => {
    for (const v of ['public', 'premium', 'hidden']) expect(canRead(restroomsSchema, 'admin', row(v), 'owner')).toBe(true)
  })

  it('lets the owner of a row read it whatever its visibility (the phase 3 submitter path)', () => {
    const own = { ...row('hidden', 'pending'), createdBy: 'user-1' }
    expect(canRead(restroomsSchema, 'member', own, 'user-1')).toBe(true)
    expect(canRead(restroomsSchema, 'member', own, 'user-2')).toBe(false)
  })
})

describe('ratings and scores read rules', () => {
  const rating = { recordId: 'r~user-1', createdBy: 'user-1', data: { restroomId: 'r', userId: 'user-1', stars: 4 } }

  it('lets only the author read a rating', () => {
    expect(canRead(restroomRatingsSchema, 'member', rating, 'user-1')).toBe(true)
    expect(canRead(restroomRatingsSchema, 'member', rating, 'user-2')).toBe(false)
    expect(canRead(restroomRatingsSchema, 'admin', rating, 'owner')).toBe(false)
    expect(canRead(restroomRatingsSchema, ROLE_ANONYMOUS, rating, '')).toBe(false)
  })

  it('lets nobody read the score summaries', () => {
    const score = { recordId: 'r', createdBy: SEEDER, data: { restroomId: 'r', score: 4.2 } }
    for (const role of [...NON_MEMBER_ROLES, 'admin']) expect(canRead(restroomScoresSchema, role, score, 'owner')).toBe(false)
  })
})
