#!/usr/bin/env node
/**
 * One-time OpenStreetMap import for five metro areas, run locally.
 *
 *   node scripts/import-osm.mjs count
 *   node scripts/import-osm.mjs fetch  [--metros la,sf]
 *   node scripts/import-osm.mjs upload --app <name|url> [--metros la,sf]
 *
 * count  – asks Overpass only for counts; stops (exit 2) if the total of
 *          candidate rows exceeds 20,000.
 * fetch  – saves raw Overpass results per 0.25° tile to data/osm/<metro>/;
 *          tiles already saved are skipped, so it resumes after a failure.
 * upload – sends saved elements to the admin-only `restrooms_import` tool via
 *          `npx deepspace agent invoke` (your CLI login; you must be the app's
 *          admin). Finished batches are recorded in data/osm/progress.json and
 *          skipped on re-run; the server also skips existing restrooms, so a
 *          re-run never duplicates and never changes a status. After every
 *          batch of a metro is saved, its grid cells are marked covered
 *          (`restrooms_mark_covered`) so live seeding skips Overpass there.
 *
 * Filtering (US only, no private toilets, fast food needs a brand) happens on
 * the server with the same code as live seeding; this script only fetches.
 * Overpass etiquette: one query at a time, a pause between queries, retries
 * with backoff, an identifying User-Agent.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const METROS = {
  la: { name: 'Los Angeles', bbox: [33.7, -118.7, 34.35, -117.65] },
  sf: { name: 'San Francisco Bay Area', bbox: [37.2, -122.55, 38.05, -121.7] },
  nyc: { name: 'New York City', bbox: [40.49, -74.27, 40.92, -73.68] },
  chicago: { name: 'Chicago', bbox: [41.64, -87.95, 42.07, -87.52] },
  seattle: { name: 'Seattle', bbox: [47.4, -122.45, 47.78, -122.1] },
}
const ROW_LIMIT = 20_000
const TILE_DEGREES = 0.25
const DATA_DIR = 'data/osm'
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
const USER_AGENT = 'hurry-up-import/0.1 (+https://hurry-up.app.space)'
const PAUSE_MS = 3000
const BACKOFF_MS = [10_000, 30_000, 60_000, 120_000]
/** Tags the server's mapping reads; everything else is dropped to keep batches small. */
const KEEP_TAGS = ['amenity', 'name', 'brand', 'access', 'unisex', 'male', 'female', 'wheelchair', 'toilets:wheelchair']
const BATCH_MAX_ELEMENTS = 200
const BATCH_MAX_BYTES = 48 * 1024 // the agent route caps a request at 64 KB
/** Seeding grid size; must match CELL_DEGREES in src/lib/us-geo.ts. */
const CELL_DEGREES = 0.02
const COVER_BATCH = 500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function args() {
  const [command, ...rest] = process.argv.slice(2)
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1]
  }
  const metros = (opts.metros ?? Object.keys(METROS).join(',')).split(',')
  for (const m of metros) if (!METROS[m]) throw new Error(`Unknown metro "${m}". Known: ${Object.keys(METROS).join(', ')}`)
  return { command, app: opts.app, metros }
}

const selectors = (bbox) => {
  const b = bbox.join(',')
  return `nwr["amenity"="toilets"](${b});nwr["amenity"="fast_food"]["brand"](${b});`
}

/** POST a query, trying each endpoint, with backoff between rounds. Returns parsed JSON. */
async function overpass(query) {
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    for (const endpoint of ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(180_000),
        })
        if (!res.ok) {
          log(`  ${new URL(endpoint).host} answered ${res.status}`)
          continue
        }
        const json = await res.json()
        if (json.remark && /error/i.test(json.remark)) {
          log(`  ${new URL(endpoint).host} remark: ${json.remark.slice(0, 120)}`)
          continue
        }
        return json
      } catch (err) {
        log(`  ${new URL(endpoint).host} failed: ${err.message}`)
      }
    }
    if (attempt < BACKOFF_MS.length) {
      log(`  all endpoints failed; retrying in ${BACKOFF_MS[attempt] / 1000}s`)
      await sleep(BACKOFF_MS[attempt])
    }
  }
  throw new Error('Overpass unavailable after all retries')
}

function tilesFor([south, west, north, east]) {
  const tiles = []
  for (let s = south; s < north - 1e-9; s += TILE_DEGREES) {
    for (let w = west; w < east - 1e-9; w += TILE_DEGREES) {
      const box = [s, w, Math.min(s + TILE_DEGREES, north), Math.min(w + TILE_DEGREES, east)].map((n) => +n.toFixed(4))
      tiles.push({ key: box.join('_'), box })
    }
  }
  return tiles
}

async function count(metros) {
  let total = 0
  const result = {}
  for (const m of metros) {
    const { name, bbox } = METROS[m]
    log(`counting ${name}…`)
    const json = await overpass(`[out:json][timeout:120];(${selectors(bbox)});out count;`)
    const n = Number(json.elements?.[0]?.tags?.total ?? NaN)
    if (!Number.isFinite(n)) throw new Error(`No count returned for ${name}`)
    result[m] = n
    total += n
    log(`  ${name}: ${n} candidate elements`)
    await sleep(PAUSE_MS)
  }
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(join(DATA_DIR, 'counts.json'), JSON.stringify({ countedAt: new Date().toISOString(), result, total }, null, 2))
  log(`total: ${total} candidate elements (before dropping private toilets and duplicates)`)
  if (total > ROW_LIMIT) {
    log(`STOP: ${total} exceeds the ${ROW_LIMIT} row limit. Nothing fetched or uploaded.`)
    process.exit(2)
  }
}

function trim(el) {
  const tags = {}
  for (const k of KEEP_TAGS) if (el.tags?.[k] !== undefined) tags[k] = el.tags[k]
  const out = { type: el.type, id: el.id, tags }
  if (el.lat !== undefined) Object.assign(out, { lat: el.lat, lon: el.lon })
  if (el.center) out.center = { lat: el.center.lat, lon: el.center.lon }
  return out
}

async function fetchTiles(metros) {
  for (const m of metros) {
    const { name, bbox } = METROS[m]
    const dir = join(DATA_DIR, m)
    await mkdir(dir, { recursive: true })
    const tiles = tilesFor(bbox)
    log(`${name}: ${tiles.length} tiles`)
    for (const [i, tile] of tiles.entries()) {
      const file = join(dir, `${tile.key}.json`)
      if (existsSync(file)) continue
      log(`  [${i + 1}/${tiles.length}] ${tile.key}`)
      const json = await overpass(`[out:json][timeout:120];(${selectors(tile.box)});out center tags;`)
      const elements = (json.elements ?? []).map(trim)
      await writeFile(`${file}.tmp`, JSON.stringify({ fetchedAt: new Date().toISOString(), bbox: tile.box, elements }))
      await rename(`${file}.tmp`, file) // a tile file only exists once complete
      log(`    saved ${elements.length} elements`)
      await sleep(PAUSE_MS)
    }
  }
}

function batches(elements) {
  const out = []
  let current = []
  let bytes = 0
  for (const el of elements) {
    const size = JSON.stringify(el).length + 1
    if (current.length && (current.length >= BATCH_MAX_ELEMENTS || bytes + size > BATCH_MAX_BYTES)) {
      out.push(current)
      current = []
      bytes = 0
    }
    current.push(el)
    bytes += size
  }
  if (current.length) out.push(current)
  return out
}

/** Run an admin tool through the DeepSpace CLI; returns its result or throws. */
async function invokeTool(app, tool, input) {
  // The CLI reads input files only from inside the project.
  const inputFile = join(DATA_DIR, '.batch.json')
  await writeFile(inputFile, JSON.stringify(input))
  const { stdout } = await run('npx', ['deepspace', 'agent', 'invoke', app, tool, '--input-file', inputFile, '--json'], {
    maxBuffer: 1 << 20,
  }).catch((err) => ({ stdout: err.stdout ?? '' }))
  const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? ''
  let result
  try {
    result = JSON.parse(line)
  } catch {
    throw new Error(`Unreadable CLI output for ${tool}: ${stdout.slice(0, 300)}`)
  }
  if (result.ok === false) throw new Error(`${tool} refused: ${JSON.stringify(result).slice(0, 300)}`)
  return result.result ?? result.output ?? result
}

/** Grid cells lying entirely inside a bounding box (cells on its edge are only partly fetched). */
function cellsInside([south, west, north, east]) {
  const idx = (deg) => Math.round((deg / CELL_DEGREES) * 1e6) / 1e6
  const keys = []
  for (let i = Math.ceil(idx(south)); i + 1 <= Math.floor(idx(north)); i++) {
    for (let j = Math.ceil(idx(west)); j + 1 <= Math.floor(idx(east)); j++) keys.push(`${i}_${j}`)
  }
  return keys
}

async function upload(metros, app) {
  if (!app) throw new Error('upload needs --app <app name or URL>, e.g. --app http://localhost:5173 or --app hurry-up')
  const progressFile = join(DATA_DIR, 'progress.json')
  const progress = existsSync(progressFile) ? JSON.parse(await readFile(progressFile, 'utf8')) : {}
  const key = (k) => `${app}|${k}`
  const seen = new Set() // ways/relations spanning two tiles are sent once
  const totals = { created: 0, skipped: 0, failed: 0, rejected: 0 }
  for (const m of metros) {
    const dir = join(DATA_DIR, m)
    if (!existsSync(dir)) {
      log(`${METROS[m].name}: no fetched tiles (run fetch first); skipping`)
      continue
    }
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
    const metro = { created: 0, skipped: 0, failed: 0, rejected: 0 }
    for (const f of files) {
      const { elements } = JSON.parse(await readFile(join(dir, f), 'utf8'))
      const fresh = elements.filter((el) => {
        const id = `${el.type}/${el.id}`
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      for (const [i, batch] of batches(fresh).entries()) {
        const id = `${m}/${f}#${i}`
        if (progress[key(id)]) continue
        let r
        try {
          r = await invokeTool(app, 'restrooms_import', { elements: batch })
        } catch (err) {
          throw new Error(`Batch ${id}: ${err.message}. Fix and re-run; finished batches are skipped.`)
        }
        if (typeof r.created !== 'number') throw new Error(`Batch ${id}: unexpected result ${JSON.stringify(r).slice(0, 200)}`)
        log(`  ${id}: created ${r.created}, skipped ${r.skipped}, rejected ${r.rejected}, failed ${r.failed}`)
        // Only a fully saved batch is marked done; a partial one is retried on re-run.
        if (r.failed > 0) throw new Error(`Batch ${id} had ${r.failed} failed writes; re-run to retry it.`)
        progress[key(id)] = { created: r.created, skipped: r.skipped, rejected: r.rejected, at: new Date().toISOString() }
        await writeFile(progressFile, JSON.stringify(progress, null, 2))
        for (const k of Object.keys(metro)) metro[k] += r[k] ?? 0
      }
    }
    log(`${METROS[m].name}: ${JSON.stringify(metro)}`)
    for (const k of Object.keys(totals)) totals[k] += metro[k]

    // Every batch of this metro is saved (a failure would have thrown above).
    // Mark its cells covered only if every tile was fetched.
    const missing = tilesFor(METROS[m].bbox).filter((t) => !files.includes(`${t.key}.json`))
    if (missing.length) {
      log(`${METROS[m].name}: ${missing.length} tile(s) not fetched; cells NOT marked covered (run fetch, then upload again)`)
      continue
    }
    if (progress[key(`covered:${m}`)]) continue
    const cells = cellsInside(METROS[m].bbox)
    let marked = 0
    for (let i = 0; i < cells.length; i += COVER_BATCH) {
      const r = await invokeTool(app, 'restrooms_mark_covered', { cellKeys: cells.slice(i, i + COVER_BATCH) })
      if (r.failed || r.invalid) throw new Error(`Marking ${METROS[m].name} covered: ${JSON.stringify(r)}; re-run to retry.`)
      marked += r.marked
    }
    progress[key(`covered:${m}`)] = { cells: marked, at: new Date().toISOString() }
    await writeFile(progressFile, JSON.stringify(progress, null, 2))
    log(`${METROS[m].name}: ${marked} cells marked covered`)
  }
  log(`done (this run): ${JSON.stringify(totals)}`)
}

const { command, app, metros } = args()
if (command === 'count') await count(metros)
else if (command === 'fetch') await fetchTiles(metros)
else if (command === 'upload') await upload(metros, app)
else {
  console.error('Usage: node scripts/import-osm.mjs count | fetch [--metros la,sf] | upload --app <name|url> [--metros la,sf]')
  process.exit(1)
}
