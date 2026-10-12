/**
 * Ratings over the wire: a non-member's WebSocket never carries a premium
 * restroom, before or after a rating makes one.
 *
 * 1. A signed-out visitor loads a downtown Seattle cell: every row in the
 *    cell's snapshot is 'public'.
 * 2. A test account (a non-member: hasMembership is admins only until phase 4)
 *    rates an unrated, public restroom 5 stars. The action answers
 *    visibleToCaller: false with no score, the panel closes, and the map says
 *    the restroom is now members only.
 * 3. While that happens the visitor's socket is sent nothing about it, and a
 *    fresh visitor's snapshot of the cell no longer contains it.
 *
 * Side effect: each run leaves one more restroom in the cell premium (rated
 * 5 by the test account). The cell is seeded first if it is empty, which asks
 * Overpass when the bulk import did not cover it.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

test.skip(loadAllTestAccounts().length < 1, 'Needs one usable test account (npx deepspace test accounts list --usable).')

const CELL = '2380_-6117' // downtown Seattle, 0.02° grid cell
const CELL_CENTER = { latitude: 47.61, longitude: -122.33 }

type Row = { recordId: string; data: { name: string; latitude: number; longitude: number; visibility?: string } }
type Frame = { at: number; sent: boolean; payload: string }

function recordFrames(page: Page): Frame[] {
  const frames: Frame[] = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => frames.push({ at: Date.now(), sent: false, payload: String(f.payload) }))
    ws.on('framesent', (f) => frames.push({ at: Date.now(), sent: true, payload: String(f.payload) }))
  })
  return frames
}

async function cellSnapshot(frames: Frame[], since = 0): Promise<Row[]> {
  let found: Frame | undefined
  await expect
    .poll(
      () =>
        (found = frames.find(
          (f) => !f.sent && f.at >= since && f.payload.includes('core.query_result') && f.payload.includes(`"cellKey":"${CELL}"`),
        )),
      { timeout: 30_000 },
    )
    .toBeTruthy()
  return JSON.parse(found!.payload).payload.records as Row[]
}

async function openMap(context: BrowserContext, at: { latitude: number; longitude: number }) {
  await context.grantPermissions(['geolocation'])
  await context.setGeolocation(at)
  const page = await context.newPage()
  const frames = recordFrames(page)
  await page.goto('/home')
  return { page, frames }
}

const meters = (a: Row['data'], b: Row['data']) =>
  Math.hypot((a.latitude - b.latitude) * 111_000, (a.longitude - b.longitude) * 111_000 * Math.cos((a.latitude * Math.PI) / 180))

test('a non-member never receives a premium restroom', async ({ browser, users, request }) => {
  test.setTimeout(120_000)
  await request.post('/api/restrooms/seed', { data: { cellKey: CELL } })

  // 1. Signed out: only public rows.
  const visitor = await openMap(await browser.newContext(), CELL_CENTER)
  const before = await cellSnapshot(visitor.frames)
  expect(before.length).toBeGreaterThan(0)
  expect(before.every((r) => r.data.visibility === 'public')).toBe(true)

  // Pick an unrated restroom (sample score) with nobody else within 40 m, so
  // the test account's auto-select opens exactly it.
  const scores = (await (await request.post('/api/restrooms/scores', { data: { ids: before.slice(0, 50).map((r) => r.recordId) } })).json())
    .data.scores as Record<string, { sample: boolean; score: number }>
  const target = before.find(
    (r) => scores[r.recordId]?.sample && before.every((o) => o === r || meters(o.data, r.data) > 40),
  )
  test.skip(!target, 'No unrated, isolated restroom left in the cell')

  // 2. The test account rates it 5 stars.
  const [tester] = await users(1)
  const { page } = await openMap(tester.page.context(), { latitude: target!.data.latitude, longitude: target!.data.longitude })
  const panel = page.getByTestId('restroom-details')
  await expect(panel.getByRole('heading', { name: target!.data.name })).toBeVisible({ timeout: 45_000 })
  const ratedAt = Date.now()
  const answer = page.waitForResponse((r) => r.url().includes('/api/actions/rateRestroom'))
  await panel.getByRole('button', { name: '5 stars' }).click()
  expect(await (await answer).json()).toEqual({ success: true, data: { visibleToCaller: false, stars: 5 } })
  await expect(panel).toHaveCount(0)
  await expect(page.getByText('This restroom is now members only.')).toBeVisible()
  await expect(page.getByTestId('members-note')).toBeVisible()

  // 3. Nothing about it reaches the open visitor; a fresh visitor no longer gets it.
  await page.waitForTimeout(2000)
  const pushed = visitor.frames.filter((f) => !f.sent && f.at >= ratedAt)
  expect(pushed.filter((f) => f.payload.includes(target!.recordId) || f.payload.includes('"premium"'))).toEqual([])

  const fresh = await openMap(await browser.newContext(), CELL_CENTER)
  const after = await cellSnapshot(fresh.frames)
  expect(after.map((r) => r.recordId)).not.toContain(target!.recordId)
  expect(after.every((r) => r.data.visibility === 'public')).toBe(true)
})
