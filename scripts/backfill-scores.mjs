#!/usr/bin/env node
/**
 * Sets the sample score and visibility on every existing restroom, run locally
 * against a deployed (or local) app with your CLI login. You must be the
 * app's admin.
 *
 *   node scripts/backfill-scores.mjs --app <name|url> [--concurrency 4]
 *
 * 1. Pages through `restrooms_list_cells` to get every cell with restrooms.
 * 2. Sends the cells to `restrooms_backfill_scores`, 10 per call, a few calls
 *    at a time (different cells never touch the same rows). One call does a
 *    bounded amount of work (a Worker invocation may make only so many
 *    subrequests); a call answering complete: false is repeated with the
 *    same cells until they are done.
 *
 * Safe to re-run at any time, including after an interruption: rows that are
 * already correct are skipped without a write, rated restrooms are
 * recomputed from their ratings, never reset. A run that reports
 * failed > 0 should simply be run again.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CELLS_PER_CALL = 10 // MAX_BACKFILL_CELLS_PER_CALL in src/server/restroom-admin-tools.ts
const RETRIES = 3
/** A batch needs a few calls the first time (dense cells); this only catches a stuck one. */
const MAX_CALLS_PER_BATCH = 50

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const app = opt('app')
const concurrency = Number(opt('concurrency', '4'))
if (!app || !(concurrency >= 1)) {
  console.error('Usage: node scripts/backfill-scores.mjs --app <name|url> [--concurrency 4]')
  process.exit(1)
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const tmp = await mkdtemp(join(tmpdir(), 'backfill-scores-'))
let fileNo = 0

async function invokeTool(tool, input) {
  const inputFile = join(tmp, `input-${fileNo++}.json`)
  await writeFile(inputFile, JSON.stringify(input))
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await run('npx', ['deepspace', 'agent', 'invoke', app, tool, '--input-file', inputFile, '--json'], {
        maxBuffer: 16 * 1024 * 1024,
      })
      const res = JSON.parse(stdout)
      if (!res.ok) throw new Error(`${res.code}: ${res.error}`)
      return res.result
    } catch (err) {
      if (attempt >= RETRIES) throw err
      log(`  ${tool} failed (${err.message.split('\n')[0]}); retrying`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}

const started = Date.now()
const cellKeys = []
let totalRestrooms = 0
for (let offset = 0; offset !== null; ) {
  const page = await invokeTool('restrooms_list_cells', { offset })
  cellKeys.push(...page.cellKeys)
  totalRestrooms = page.totalRestrooms
  if (page.missingCell > 0) log(`warning: ${page.missingCell} restrooms have no cellKey; run restrooms_backfill_cellkey first`)
  offset = page.nextOffset
}
log(`${totalRestrooms} restrooms in ${cellKeys.length} cells`)

const batches = []
for (let i = 0; i < cellKeys.length; i += CELLS_PER_CALL) batches.push(cellKeys.slice(i, i + CELLS_PER_CALL))
const total = { restrooms: 0, recomputed: 0, alreadySet: 0, failed: 0, invalid: 0 }
let next = 0
let done = 0
async function worker() {
  while (next < batches.length) {
    const batch = batches[next++]
    // One call does a bounded amount of work (the Worker subrequest limit);
    // repeat it until the server says these cells are complete. Rows already
    // done are skipped, so only the last call's alreadySet counts.
    let r
    let calls = 0
    do {
      r = await invokeTool('restrooms_backfill_scores', { cellKeys: batch })
      total.recomputed += r.recomputed ?? 0
      total.failed += r.failed ?? 0
      if (++calls > MAX_CALLS_PER_BATCH) throw new Error(`cells ${batch.join(',')} still incomplete after ${calls} calls`)
    } while (!r.complete)
    total.restrooms += r.restrooms ?? 0
    total.alreadySet += r.alreadySet ?? 0
    total.invalid += r.invalid ?? 0
    done++
    if (done % 20 === 0 || done === batches.length) {
      log(`  ${done}/${batches.length} calls, ${total.restrooms} restrooms, ${((Date.now() - started) / 1000).toFixed(0)} s`)
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))

const seconds = (Date.now() - started) / 1000
log(`done in ${seconds.toFixed(1)} s: ${JSON.stringify(total)}`)
if (total.failed > 0) {
  log(`${total.failed} restrooms failed; run the script again (it skips everything already correct)`)
  process.exit(2)
}
