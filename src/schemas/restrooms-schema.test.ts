/**
 * The (cellKey, osmId) uniqueOn index must never block restrooms that have
 * no osmId. These tests run the SDK's own SQL against real SQLite
 * (node:sqlite): the CREATE UNIQUE INDEX that RecordRoom issues for uniqueOn,
 * and the duplicate check it runs before every write (both copied from
 * node_modules/deepspace/dist/worker.js, SDK 0.39.3).
 */

import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { normalizeRestroom, restroomsSchema, type Restroom } from './restrooms-schema'

// SDK naming: table c_<collection>, column col_<lowercased name>.
const TABLE = 'c_restrooms'
const col = (name: string) => `col_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`

function freshDb() {
  const db = new DatabaseSync(':memory:')
  const cols = restroomsSchema.columns.map((c) => `"${col(c.name)}" ${c.storage === 'number' ? 'REAL' : 'TEXT'}`)
  db.exec(`CREATE TABLE ${TABLE} (_row_id TEXT PRIMARY KEY, ${cols.join(', ')})`)
  const unique = restroomsSchema.uniqueOn!
  db.exec(
    `CREATE UNIQUE INDEX "uniq_${TABLE}_${unique.join('_')}" ON ${TABLE} (${unique.map((n) => `"${col(n)}"`).join(', ')})`,
  )
  return db
}

/** The SDK write path: absent → NULL, "" stays "" for text; duplicate check, then insert. */
function sdkCreate(db: DatabaseSync, id: string, data: Partial<Restroom>): { success: boolean } {
  const value = (name: string) => {
    const v = (data as Record<string, unknown>)[name]
    return v === undefined || v === null ? null : (v as string | number)
  }
  const unique = restroomsSchema.uniqueOn!
  const conflict = db
    .prepare(`SELECT _row_id FROM ${TABLE} WHERE ${unique.map((n) => `"${col(n)}" = ?`).join(' AND ')} LIMIT 1`)
    .all(...unique.map(value))
  if (conflict.length > 0) return { success: false }
  const names = restroomsSchema.columns.map((c) => c.name)
  db.prepare(
    `INSERT INTO ${TABLE} (_row_id, ${names.map((n) => `"${col(n)}"`).join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`,
  ).run(id, ...names.map(value))
  return { success: true }
}

const base: Restroom = {
  name: 'Corner cafe restroom',
  latitude: 34.05,
  longitude: -118.25,
  kind: 'public',
  genderType: 'unknown',
  wheelchair: 'unknown',
  source: 'user',
  status: 'pending',
  cellKey: '1702_-5913',
}

describe('restrooms uniqueOn (cellKey, osmId)', () => {
  it('declares the index columns in this order (cellKey first, for per-cell lookups)', () => {
    expect(restroomsSchema.uniqueOn).toEqual(['cellKey', 'osmId'])
  })

  it('lets two restrooms without an osmId in the same cell both be created', () => {
    const db = freshDb()
    expect(sdkCreate(db, 'user-a', normalizeRestroom({ ...base }))).toEqual({ success: true })
    expect(sdkCreate(db, 'user-b', normalizeRestroom({ ...base, name: 'Another' }))).toEqual({ success: true })
    const rows = db.prepare(`SELECT _row_id, ${col('osmId')} AS osm FROM ${TABLE}`).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.osm === null)).toBe(true)
  })

  it('stores an empty osmId as NULL, so it cannot collide', () => {
    const db = freshDb()
    expect(sdkCreate(db, 'user-a', normalizeRestroom({ ...base, osmId: '' }))).toEqual({ success: true })
    expect(sdkCreate(db, 'user-b', normalizeRestroom({ ...base, osmId: '  ' }))).toEqual({ success: true })
  })

  it('would collide if "" reached the database (why normalizeRestroom exists)', () => {
    const db = freshDb()
    expect(sdkCreate(db, 'user-a', { ...base, osmId: '' })).toEqual({ success: true })
    expect(sdkCreate(db, 'user-b', { ...base, osmId: '' })).toEqual({ success: false })
  })

  it('still refuses the same OSM element twice in one cell', () => {
    const db = freshDb()
    const osm = { ...base, source: 'osm' as const, status: 'active' as const, osmId: 'node/1' }
    expect(sdkCreate(db, 'osm-node-1', osm)).toEqual({ success: true })
    expect(sdkCreate(db, 'osm-node-1-dup', osm)).toEqual({ success: false })
  })
})

describe('normalizeRestroom', () => {
  it('drops blank osmId and brand and keeps real values', () => {
    expect(normalizeRestroom({ ...base, osmId: '', brand: ' ' })).not.toHaveProperty('osmId')
    expect(normalizeRestroom({ ...base, osmId: '', brand: ' ' })).not.toHaveProperty('brand')
    expect(normalizeRestroom({ ...base, osmId: 'way/7', brand: 'Subway' })).toMatchObject({ osmId: 'way/7', brand: 'Subway' })
  })
})
