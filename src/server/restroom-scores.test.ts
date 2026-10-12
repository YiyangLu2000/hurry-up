import { describe, expect, it } from 'vitest'
import { sampleScore } from '../lib/scores'
import { ratingRecordId } from '../schemas/ratings-schema'
import type { Restroom } from '../schemas/restrooms-schema'
import { fakeRecordTools } from './fake-record-tools'
import { backfillCell, recomputeRestroom } from './restroom-scores'

const CELL = '2382_-6117'
const PUBLIC_ID = 'osm-node-42' // sample 3.6
const PREMIUM_ID = 'osm-way-123456' // sample 4.1

function restroom(status: Restroom['status'] = 'active', extra: Partial<Restroom> = {}): Restroom {
  return {
    name: 'Test', latitude: 47.64, longitude: -122.32, kind: 'public', genderType: 'unknown',
    wheelchair: 'unknown', source: 'osm', status, cellKey: CELL, ...extra,
  }
}

function setup(ids: string[] = [PUBLIC_ID]) {
  const fake = fakeRecordTools()
  for (const id of ids) fake.table('restrooms').set(id, { ...restroom() })
  const rate = (restroomId: string, userId: string, stars: number) =>
    fake.table('restroom_ratings').set(ratingRecordId(restroomId, userId), { restroomId, userId, stars, updatedAt: 1 })
  return { ...fake, rate }
}

describe('recomputeRestroom', () => {
  it('uses the sample score until a restroom has ratings', async () => {
    const { tools, table } = setup()
    expect(sampleScore(PUBLIC_ID)).toBe(3.6)
    expect(await recomputeRestroom(tools, PUBLIC_ID)).toEqual({ score: 3.6, ratingCount: 0, sample: true, visibility: 'public' })
    expect(table('restroom_scores').get(PUBLIC_ID)).toMatchObject({ sampleScore: 3.6, ratingCount: 0, ratingSum: 0, score: 3.6, cellKey: CELL })
  })

  it('updates count and average as ratings arrive and change', async () => {
    const { tools, table, rate } = setup()
    rate(PUBLIC_ID, 'u1', 3)
    expect(await recomputeRestroom(tools, PUBLIC_ID)).toMatchObject({ score: 3, ratingCount: 1, sample: false })
    rate(PUBLIC_ID, 'u2', 4)
    expect(await recomputeRestroom(tools, PUBLIC_ID)).toMatchObject({ score: 3.5, ratingCount: 2 })
    rate(PUBLIC_ID, 'u1', 1) // u1 changes their rating: still one rating from u1
    expect(await recomputeRestroom(tools, PUBLIC_ID)).toMatchObject({ score: 2.5, ratingCount: 2 })
    expect(table('restroom_scores').get(PUBLIC_ID)).toMatchObject({ ratingCount: 2, ratingSum: 5, score: 2.5, sampleScore: 3.6 })
  })

  it('makes a restroom premium when its score crosses above 4.0, and public again when it drops', async () => {
    const { tools, table, rate } = setup()
    rate(PUBLIC_ID, 'u1', 5)
    expect((await recomputeRestroom(tools, PUBLIC_ID))?.visibility).toBe('premium')
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('premium')
    rate(PUBLIC_ID, 'u2', 3) // average 4.0: not above 4.0
    expect((await recomputeRestroom(tools, PUBLIC_ID))?.visibility).toBe('public')
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('public')
  })

  it('takes a premium sample down to public when real ratings arrive', async () => {
    const { tools, table, rate } = setup([PREMIUM_ID])
    expect((await recomputeRestroom(tools, PREMIUM_ID))?.visibility).toBe('premium')
    rate(PREMIUM_ID, 'u1', 2)
    expect(await recomputeRestroom(tools, PREMIUM_ID)).toMatchObject({ score: 2, visibility: 'public' })
    expect(table('restrooms').get(PREMIUM_ID)?.visibility).toBe('public')
  })

  it('hides a restroom whose status is not active, and shows it again when it is', async () => {
    const { tools, table } = setup()
    table('restrooms').set(PUBLIC_ID, { ...restroom('unavailable') })
    expect((await recomputeRestroom(tools, PUBLIC_ID))?.visibility).toBe('hidden')
    table('restrooms').set(PUBLIC_ID, { ...restroom('active'), visibility: 'hidden' })
    expect((await recomputeRestroom(tools, PUBLIC_ID))?.visibility).toBe('public')
  })

  it('returns null for a restroom that does not exist', async () => {
    const { tools } = setup()
    expect(await recomputeRestroom(tools, 'nope')).toBeNull()
  })

  it('ends correct when two raters interleave (the example in the source comment)', async () => {
    const { tools, table, hooks, rate } = setup()
    const writes: number[] = []
    const realCreate = tools.create.bind(tools)
    tools.create = (async (collection: string, data: Record<string, unknown>, id?: string) => {
      if (collection === 'restroom_scores') writes.push(data.score as number)
      return realCreate(collection, data, id)
    }) as typeof tools.create

    // Ana saves her 5 and her action reads [Ana 5]. Right after that read,
    // Ben saves his 1 and his whole action runs (3.0). Ana's action then
    // writes its stale 5.0, re-reads, sees Ben's rating and corrects to 3.0.
    rate(PUBLIC_ID, 'ana', 5)
    let benDone = false
    hooks.afterRead = async (collection) => {
      if (collection !== 'restroom_ratings' || benDone) return
      benDone = true
      rate(PUBLIC_ID, 'ben', 1)
      expect(await recomputeRestroom(tools, PUBLIC_ID)).toMatchObject({ score: 3, ratingCount: 2 })
    }
    const ana = await recomputeRestroom(tools, PUBLIC_ID)

    expect(writes).toEqual([3, 5, 3]) // Ben's 3.0, Ana's stale 5.0, Ana's correction
    expect(ana).toMatchObject({ score: 3, ratingCount: 2, visibility: 'public' })
    expect(table('restroom_scores').get(PUBLIC_ID)).toMatchObject({ ratingCount: 2, ratingSum: 6, score: 3 })
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('public')
  })
})

describe('backfillCell', () => {
  it('sets sample scores and visibility, and a re-run writes nothing', async () => {
    const { tools, table, calls } = setup([PUBLIC_ID, PREMIUM_ID, 'osm-node-7'])
    table('restrooms').set('osm-node-7', { ...restroom('unavailable') })

    expect(await backfillCell(tools, CELL)).toEqual({ restrooms: 3, alreadySet: 0, recomputed: 3, failed: 0 })
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('public')
    expect(table('restrooms').get(PREMIUM_ID)?.visibility).toBe('premium')
    expect(table('restrooms').get('osm-node-7')?.visibility).toBe('hidden')
    expect(table('restroom_scores').get(PREMIUM_ID)).toMatchObject({ sampleScore: 4.1, score: 4.1, ratingCount: 0 })

    const writesBefore = calls.writes
    expect(await backfillCell(tools, CELL)).toEqual({ restrooms: 3, alreadySet: 3, recomputed: 0, failed: 0 })
    expect(calls.writes).toBe(writesBefore)
  })

  it('never resets a rated restroom to its sample', async () => {
    const { tools, table, rate } = setup()
    rate(PUBLIC_ID, 'u1', 5)
    await recomputeRestroom(tools, PUBLIC_ID)
    await backfillCell(tools, CELL)
    expect(table('restroom_scores').get(PUBLIC_ID)).toMatchObject({ ratingCount: 1, score: 5 })
    expect(table('restrooms').get(PUBLIC_ID)?.visibility).toBe('premium')
  })
})
