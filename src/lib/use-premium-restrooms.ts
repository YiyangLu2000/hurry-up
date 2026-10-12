/**
 * Premium (top-rated) restrooms for the loaded cells, from
 * POST /api/restrooms/premium. Whether the user has membership is the
 * server's answer, not a client guess: signed-out users never ask, and a
 * signed-in user the server refuses (403) is a non-member until they sign in
 * as someone else. Refetches when the cells change and on every refresh tick.
 */

import { useEffect, useState } from 'react'
import type { Restroom } from '../schemas/restrooms-schema'
import { fetchPremium } from './ratings-api'

export type Membership = 'unknown' | 'member' | 'non-member'
type Row = { recordId: string; data: Restroom }

/** Waits for the map to settle before asking, like cell subscriptions. */
const DEBOUNCE_MS = 400

export function usePremiumRestrooms(
  userId: string | null,
  cellKeys: string[],
  refreshNonce: number,
): { membership: Membership; records: Row[] } {
  const [state, setState] = useState<{ userId: string | null; membership: Membership; records: Row[] }>({
    userId,
    membership: userId ? 'unknown' : 'non-member',
    records: [],
  })
  const current = state.userId === userId ? state : { userId, membership: (userId ? 'unknown' : 'non-member') as Membership, records: [] }
  const cellsKey = cellKeys.join(',')
  const known = current.membership

  useEffect(() => {
    if (!userId || known === 'non-member' || !cellsKey) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetchPremium(cellsKey.split(','), controller.signal)
        .then((answer) => {
          if (answer === 'no-membership') setState({ userId, membership: 'non-member', records: [] })
          else setState({ userId, membership: 'member', records: answer })
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) console.warn('[premium] fetch failed', err)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [userId, cellsKey, refreshNonce, known])

  return { membership: current.membership, records: current.records }
}
