/**
 * Restrooms - Schema
 *
 * `restrooms` is server-written only: the seeding route creates rows through
 * the RBAC-bypassing record tools, so no client role may create, update, or
 * delete. Reads use the 'published' level with `status = 'active'` as the
 * visibility value. Rows are created by a system identity, so no real user is
 * ever the owner and every non-admin caller sees exactly the active rows.
 *
 * `restroom_areas` records which seeding-grid cells were fetched from
 * Overpass and when. It is invisible to every client.
 */

import type { CollectionSchema } from 'deepspace/schema'

export type RestroomKind = 'public' | 'restaurant'
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
}

export const GENDER_TYPES: GenderType[] = ['men', 'women', 'gender-neutral', 'unknown']
export const RESTROOM_KINDS: RestroomKind[] = ['public', 'restaurant']

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
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['active', 'unavailable', 'pending'] },
      required: true,
    },
  ],
  // Dedup is by record id (`osm-<type>-<id>`), not `uniqueOn`: future
  // user-submitted rows carry no osmId.
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
  ],
  uniqueOn: ['cellKey'],
  permissions: {
    '*': { read: false, ...NO_WRITES },
    viewer: { read: false, ...NO_WRITES },
    member: { read: false, ...NO_WRITES },
    admin: { read: false, ...NO_WRITES },
  },
}
