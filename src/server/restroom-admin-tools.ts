/**
 * Admin-only restroom tools for the DeepSpace CLI (local agent):
 *
 *   npx deepspace agent tools <app> --json
 *   npx deepspace agent invoke <app> restrooms_import --input-file batch.json --json
 *
 * Three locks, all server-side:
 * 1. The agent route verifies the CLI's agent token (resolveAgentAuth) and
 *    app membership — signed-out callers get 401.
 * 2. `authorize` refuses anyone whose app role is not admin — 403.
 * 3. Every tool re-checks the admin role itself before touching data.
 *
 * Only these tools are exposed; the generic record tools in src/ai/tools.ts
 * are not registered for the CLI.
 *
 * SDK 0.39.3 hands the tool factory only a caller-RBAC executor, but these
 * tools write with the RBAC-bypassing record tools (restrooms have no client
 * write permission), so the request's env and verified caller are carried to
 * them with AsyncLocalStorage, set by a middleware on the agent tool paths.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { Hono } from 'hono'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod/v4'
import { resolveAppRole } from 'deepspace/worker'
import { toRestroom, type OverpassElement } from '../lib/osm-restrooms.js'
import { cellForPoint, cellFromKey, cellTouchesUS } from '../lib/us-geo.js'
import type { Restroom, RestroomStatus } from '../schemas/restrooms-schema.js'
import { registerAgent } from '../ai/agent.js'
import { createActionTools } from './action-routes.js'
import { resolveAgentAuth } from './http-routes.js'
import { saveNewRestrooms } from './restroom-writes.js'
import type { AppContext, Env } from '../../worker.js'

/** Rows imported from OpenStreetMap are owned by this system identity, like live seeding. */
const SEEDER_USER_ID = 'system:osm-seeder'
/** Keeps one request under the agent route's 64 KB body cap with trimmed tags. */
const MAX_ELEMENTS_PER_CALL = 300
const MAX_CELLS_PER_CALL = 1000

const requestScope = new AsyncLocalStorage<{ env: Env; userId: string | null }>()

async function requireAdmin(): Promise<{ env: Env; userId: string }> {
  const scope = requestScope.getStore()
  if (!scope?.userId) throw new Error('unauthenticated')
  if ((await resolveAppRole(scope.env, scope.userId)) !== 'admin') throw new Error('forbidden')
  return { env: scope.env, userId: scope.userId }
}

const elementSchema = z.object({
  type: z.enum(['node', 'way', 'relation']),
  id: z.number().int().positive(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  center: z.object({ lat: z.number(), lon: z.number() }).optional(),
  tags: z.record(z.string(), z.string()).optional(),
})

const STATUSES: [RestroomStatus, ...RestroomStatus[]] = ['active', 'unavailable', 'pending']

export function buildRestroomAdminTools(): ToolSet {
  return {
    restrooms_import: tool({
      description:
        'Admin only. Import raw OpenStreetMap (Overpass) elements as restrooms. Applies the same rules as live seeding (US only, no private toilets, fast food needs a brand). Creates only restrooms whose id is new; never changes an existing restroom. Safe to re-run.',
      inputSchema: z.object({ elements: z.array(elementSchema).min(1).max(MAX_ELEMENTS_PER_CALL) }),
      execute: async ({ elements }) => {
        const { env, userId } = await requireAdmin()
        const rows = elements.map((el) => toRestroom(el as OverpassElement)).filter((r) => r !== null)
        const tools = createActionTools(env, SEEDER_USER_ID, '')
        const saved = await saveNewRestrooms(tools, rows)
        console.info(
          `[restrooms] import by ${userId}: received=${elements.length} mapped=${rows.length} created=${saved.created} skipped=${saved.skipped} failed=${saved.failed}`,
        )
        return { received: elements.length, rejected: elements.length - rows.length, ...saved }
      },
    }),

    restrooms_mark_covered: tool({
      description:
        'Admin only. Mark grid cells as covered by the bulk import, so live seeding never asks Overpass for them again (no expiry). Call only after every restroom in these cells has been saved with restrooms_import. Safe to re-run.',
      inputSchema: z.object({ cellKeys: z.array(z.string()).min(1).max(MAX_CELLS_PER_CALL) }),
      execute: async ({ cellKeys }) => {
        const { env, userId } = await requireAdmin()
        const tools = createActionTools(env, SEEDER_USER_ID, '')
        const now = Math.floor(Date.now() / 1000)
        let marked = 0
        let invalid = 0
        let failed = 0
        for (const key of new Set(cellKeys)) {
          const cell = cellFromKey(key)
          if (!cell || !cellTouchesUS(cell)) {
            invalid++
            continue
          }
          // Upsert by cellKey: keeps resultCount from any earlier live seed.
          const res = await tools.create('restroom_areas', { cellKey: key, fetchedAt: now, coveredBy: 'import' }, key)
          if (res.success) marked++
          else failed++
        }
        console.info(`[restrooms] mark covered by ${userId}: marked=${marked} invalid=${invalid} failed=${failed}`)
        return { marked, invalid, failed }
      },
    }),

    restrooms_backfill_cellkey: tool({
      description:
        'Admin only, one-time. Sets cellKey on restrooms that do not have one yet (rows created before per-cell loading). Changes nothing else. Safe to re-run.',
      inputSchema: z.object({}),
      execute: async () => {
        const { env, userId } = await requireAdmin()
        const tools = createActionTools(env, userId, '')
        const all = await tools.query('restrooms')
        if (!all.success) throw new Error(all.error)
        const rows = (all.data as { records: { recordId: string; data: Partial<Restroom> }[] }).records
        let updated = 0
        let failed = 0
        for (const r of rows) {
          const { latitude, longitude, cellKey } = r.data
          if (cellKey || typeof latitude !== 'number' || typeof longitude !== 'number') continue
          const res = await tools.update('restrooms', r.recordId, {
            cellKey: cellForPoint(latitude, longitude).key,
          })
          if (res.success) updated++
          else failed++
        }
        console.info(`[restrooms] backfill by ${userId}: total=${rows.length} updated=${updated} failed=${failed}`)
        return { total: rows.length, updated, alreadySet: rows.length - updated - failed, failed }
      },
    }),

    restrooms_set_status: tool({
      description:
        "Admin only. Set one restroom's status: active (shown to everyone), unavailable or pending (hidden from everyone but admins).",
      inputSchema: z.object({ recordId: z.string().min(1), status: z.enum(STATUSES) }),
      execute: async ({ recordId, status }) => {
        const { env, userId } = await requireAdmin()
        const tools = createActionTools(env, userId, '')
        const existing = await tools.get('restrooms', recordId)
        if (!existing.success) return { ok: false, error: 'not_found', recordId }
        const previous = existing.data.record.data.status as RestroomStatus | undefined
        const res = await tools.update('restrooms', recordId, { status })
        console.info(`[restrooms] status ${recordId}: ${previous} -> ${status} by ${userId}`)
        return res.success ? { ok: true, recordId, previous, status } : { ok: false, error: res.error, recordId }
      },
    }),
  }
}

/** Register the CLI-only tool routes. Call before the platform proxy and static fallback. */
export function registerRestroomAdminTools(app: Hono<AppContext>): void {
  const bindScope = async (c: { req: { raw: Request }; env: Env }, next: () => Promise<void>) => {
    const auth = await resolveAgentAuth(c.req.raw, c.env)
    return requestScope.run({ env: c.env, userId: auth?.userId ?? null }, next)
  }
  app.use('/_deepspace/agent/tools', bindScope)
  app.use('/_deepspace/agent/tools/*', bindScope)
  registerAgent(app, {
    tools: buildRestroomAdminTools,
    inApp: false,
    authorize: async ({ userId, env }) => {
      const role = await resolveAppRole(env, userId)
      // Audit trail for refused callers (signed-in app members who are not admins).
      if (role !== 'admin') console.warn(`[restrooms] admin tools refused: user=${userId} role=${role}`)
      return role === 'admin'
    },
  })
}
