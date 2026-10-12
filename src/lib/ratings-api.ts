/**
 * Browser side of ratings: the rateRestroom action and the two score routes
 * (src/actions/rate-restroom.ts, src/server/score-routes.ts). The signed-in
 * user's JWT goes in the Authorization header when there is one; the server
 * decides everything else.
 */

import { getAuthToken } from 'deepspace'
import type { Restroom } from '../schemas/restrooms-schema'

export type ScoreAnswer = { score: number; sample: boolean; ratingCount: number }
export type RateAnswer =
  | { visibleToCaller: true; stars: number; score: number; ratingCount: number; sample: boolean }
  | { visibleToCaller: false; stars: number }

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const token = await getAuthToken()
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal,
  })
}

export async function rateRestroom(restroomId: string, stars: number): Promise<RateAnswer> {
  const res = await post('/api/actions/rateRestroom', { restroomId, stars })
  const json = (await res.json().catch(() => null)) as { success?: boolean; data?: RateAnswer; error?: string } | null
  if (!res.ok || !json?.success || !json.data) throw new Error(json?.error ?? 'Your rating could not be saved.')
  return json.data
}

/** Scores for the restrooms the caller can see; others are simply absent. */
export async function fetchScores(ids: string[], signal?: AbortSignal): Promise<Record<string, ScoreAnswer>> {
  const res = await post('/api/restrooms/scores', { ids }, signal)
  if (!res.ok) throw new Error(`scores answered ${res.status}`)
  return ((await res.json()) as { data: { scores: Record<string, ScoreAnswer> } }).data.scores
}

/** Premium restrooms in these cells, or 'no-membership' when the server refuses (401/403). */
export async function fetchPremium(
  cellKeys: string[],
  signal?: AbortSignal,
): Promise<{ recordId: string; data: Restroom }[] | 'no-membership'> {
  const res = await post('/api/restrooms/premium', { cellKeys }, signal)
  if (res.status === 401 || res.status === 403) return 'no-membership'
  if (!res.ok) throw new Error(`premium answered ${res.status}`)
  return ((await res.json()) as { data: { records: { recordId: string; data: Restroom }[] } }).data.records
}
