/**
 * Restrooms - Schema
 *
 * `restrooms` is server-written only: the seeding route creates rows through
 * the RBAC-bypassing record tools, so no client role may create, update, or
 * delete. Reads use the 'published' level with `status = 'active'` as the
 * visibility value. Rows are created by a system identity, so no real user is
 * ever the owner and every non-admin caller sees exactly the active rows.
 *
 * Clients load restrooms per seeding-grid cell (`where: { cellKey }`), never
 * the whole collection. Every server write goes through `normalizeRestroom`.
 *
 * `restroom_areas` records which seeding-grid cells were fetched from
 * Overpass and when, or covered by the bulk import. Invisible to every client.
 */

import type { CollectionSchema } from 'deepspace/schema'
import type { Visibility } from '../lib/scores.js'

/** public toilet, chain fast food, or chain café (the last two may be for customers only). */
export type RestroomKind = 'public' | 'restaurant' | 'cafe'
export type GenderType = 'men' | 'women' | 'gender-neutral' | 'unknown'
export type Wheelchair = 'yes' | 'no' | 'unknown'
export type RestroomStatus = 'active' | 'unavailable' | 'pending'

export interface Restroom {
  name: string
  latitude: number
  longitude: number
  kind: RestroomKind
  brand?: string
  genderType: GenderType
  wheelchair: Wheelchair
  source: 'osm' | 'user'
  osmId?: string
  status: RestroomStatus
  /**
   * Who may see this restroom, computed only by the server from status and
   * score (src/lib/scores.ts, src/server/restroom-scores.ts). Absent only on
   * rows created before ratings, until the backfill sets it.
   */
  visibility?: Visibility
  /** Seeding-grid cell (`cellForPoint` in src/lib/us-geo.ts); server-computed. */
  cellKey: string
}

/**
 * The one shape every server write uses. An empty or blank `osmId` (or
 * `brand`) is dropped so it is stored as NULL: the SDK stores "" as "", and
 * two "" osmIds in one cell would collide on the (cellKey, osmId) index.
 */
export function normalizeRestroom(row: Restroom): Restroom {
  const out: Restroom = { ...row }
  if (!out.osmId?.trim()) delete out.osmId
  if (!out.brand?.trim()) delete out.brand
  return out
}

export const GENDER_TYPES: GenderType[] = ['men', 'women', 'gender-neutral', 'unknown']
export const RESTROOM_KINDS: RestroomKind[] = ['public', 'restaurant', 'cafe']

const NO_WRITES = { create: false, update: false, delete: false } as const

export const restroomsSchema: CollectionSchema = {
  name: 'restrooms',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true },
    { name: 'latitude', storage: 'number', interpretation: 'plain', required: true },
    { name: 'longitude', storage: 'number', interpretation: 'plain', required: true },
    { name: 'kind', storage: 'text', interpretation: { kind: 'select', options: RESTROOM_KINDS }, required: true },
    { name: 'brand', storage: 'text', interpretation: 'plain' },
    { name: 'genderType', storage: 'text', interpretation: { kind: 'select', options: GENDER_TYPES }, required: true },
    { name: 'wheelchair', storage: 'text', interpretation: { kind: 'select', options: ['yes', 'no', 'unknown'] } },
    { name: 'source', storage: 'text', interpretation: { kind: 'select', options: ['osm', 'user'] }, required: true },
    { name: 'osmId', storage: 'text', interpretation: 'plain' },
    { name: 'cellKey', storage: 'text', interpretation: 'plain' },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['active', 'unavailable', 'pending'] },
      required: true,
    },
    {
      name: 'visibility',
      storage: 'text',
      interpretation: { kind: 'select', options: ['public', 'premium', 'hidden'] },
    },
  ],
  // This uniqueOn exists for the SQLite index it creates on (cellKey, osmId),
  // which turns the client's per-cell `where: { cellKey }` query into an index
  // lookup instead of a full-table scan. That index is undocumented SDK
  // behaviour (RecordRoom issues CREATE UNIQUE INDEX for uniqueOn); if it ever
  // stops, queries still work, only as scans. The uniqueness itself is not the
  // goal: dedup is by record id (`osm-<type>-<id>`). Rows without an osmId
  // (future user submissions) store NULL, and NULL never conflicts — see
  // normalizeRestroom and restrooms-schema.test.ts.
  uniqueOn: ['cellKey', 'osmId'],
  visibilityField: { field: 'status', value: 'active' },
  permissions: {
    '*': { read: 'published', ...NO_WRITES },
    viewer: { read: 'published', ...NO_WRITES },
    member: { read: 'published', ...NO_WRITES },
    admin: { read: true, ...NO_WRITES },
  },
}

export const restroomAreasSchema: CollectionSchema = {
  name: 'restroom_areas',
  columns: [
    { name: 'cellKey', storage: 'text', interpretation: 'plain', required: true },
    { name: 'fetchedAt', storage: 'number', interpretation: 'plain', required: true },
    { name: 'resultCount', storage: 'number', interpretation: 'plain' },
    // 'import' once the bulk import saved this cell's restrooms: live seeding
    // then never asks Overpass for it again (no 7-day expiry).
    { name: 'coveredBy', storage: 'text', interpretation: { kind: 'select', options: ['import'] } },
    // Which mapping rules the live fetch used (SEED_RULES_VERSION). A fetch
    // under older rules (e.g. before cafés) is stale and fetched again.
    { name: 'rulesVersion', storage: 'number', interpretation: 'plain' },
  ],
  uniqueOn: ['cellKey'],
  permissions: {
    '*': { read: false, ...NO_WRITES },
    viewer: { read: false, ...NO_WRITES },
    member: { read: false, ...NO_WRITES },
    admin: { read: false, ...NO_WRITES },
  },
}
