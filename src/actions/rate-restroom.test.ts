import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../worker'
import { fakeRecordTools } from '../server/fake-record-tools'
import { recomputeRestroom } from '../server/restroom-scores'
import { rateRestroom } from './rate-restroom'

const roles = new Map<string, string>()
vi.mock('deepspace/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('deepspace/worker')>()),
  resolveAppRole: async (_env: unknown, userId: string) => roles.get(userId) ?? 'member',
}))

const CELL = '2382_-6117'
const PUBLIC_ID = 'osm-node-42' // sample 3.6
const PREMIUM_ID = 'osm-way-123456' // sample 4.1
const env = {} as Env

function setup() {
  const fake = fakeRecordTools()
  for (const id of [PUBLIC_ID, PREMIUM_ID]) {
    fake.table('restrooms').set(id, {
      name: 'Test', latitude: 47.64, longitude: -122.32, kind: 'public', genderType: 'unknown',
      wheelchair: 'unknown', source: 'osm', status: 'active', cellKey: CELL,
    })
  }
  const rate = (userId: string, restroomId: string, stars: unknown) =>
    rateRestroom({ userId, params: { restroomId, stars }, tools: fake.tools, env, callerJwt: 'jwt' })
  return { ...fake, rate }
}

beforeEach(() => {
  roles.clear()
  roles.set('owner', 'admin')
})

describe('rateRestroom', () => {
  it.each([0, 6, 3.5, '4', null, undefined, Number.NaN])('rejects %j stars and writes nothing', async (stars) => {
    const { rate, calls } = setup()
    const res = await rate('u1', PUBLIC_ID, stars)
    expect(res.success).toBe(false)
    expect(calls.writes).toBe(0)
  })

  it('keeps one rating per user per restroom; rating again replaces it', async () => {
    const { rate, table } = setup()
    expect(await rate('u1', PUBLIC_ID, 2)).toMatchObject({ success: true, data: { visibleToCaller: true, score: 2, ratingCount: 1 } })
    expect(await rate('u1', PUBLIC_ID, 4)).toMatchObject({ success: true, data: { score: 4, ratingCount: 1 } })
    expect(await rate('u2', PUBLIC_ID, 3)).toMatchObject({ success: true, data: { score: 3.5, ratingCount: 2 } })
    expect([...table('restroom_ratings').values()].map((r) => [r.userId, r.stars])).toEqual([['u1', 4], ['u2', 3]])
  })

  it('refuses a restroom that does not exist, is not active, or that the caller cannot see', async () => {
    const { rate, table } = setup()
    expect(await rate('u1', 'nope', 3)).toMatchObject({ success: false })
    table('restrooms').set(PUBLIC_ID, { ...table('restrooms').get(PUBLIC_ID), status: 'unavailable', visibility: 'hidden' })
    expect(await rate('u1', PUBLIC_ID, 3)).toMatchObject({ success: false })
    // Premium (sample 4.1): a non-member gets the same answer as for a missing restroom.
    expect(await rate('u1', PREMIUM_ID, 3)).toEqual({ success: false, error: 'This restroom was not found.' })
    expect(table('restroom_ratings').size).toBe(0)
  })

  it('lets a member (the owner, until phase 4) rate a premium restroom', async () => {
    const { rate } = setup()
    expect(await rate('owner', PREMIUM_ID, 5)).toMatchObject({ success: true, data: { visibleToCaller: true, score: 5 } })
  })

  it("never sends a premium score to the non-member whose rating made the restroom premium", async () => {
    const { rate, table } = setup()
    const res = await rate('u1', PUBLIC_ID, 5)
    expect(res).toEqual({ success: true, data: { visibleToCaller: false, stars: 5 } })
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('premium')
  })

  it('brings a premium restroom back to public when a member rates it down', async () => {
    const { rate, tools, table } = setup()
    await recomputeRestroom(tools, PREMIUM_ID)
    expect(table('restrooms').get(PREMIUM_ID)?.visibility).toBe('premium')
    expect(await rate('owner', PREMIUM_ID, 3)).toMatchObject({ success: true, data: { visibleToCaller: true, score: 3 } })
    expect(table('restrooms').get(PREMIUM_ID)?.visibility).toBe('public')
  })
})
