/**
 * Loads restrooms one seeding-grid cell at a time: one `useQuery` per cell,
 * `where: { cellKey }`. Mounting a cell subscribes; unmounting unsubscribes.
 *
 * Keep these queries free of `orderBy` and `limit`: the SDK client re-sends
 * (and the server re-runs) such a query on every change to the collection,
 * while a plain `where` query just applies or drops each change locally.
 *
 * Refresh: whenever `refreshNonce` changes, every mounted cell re-sends its
 * subscription under the same subscription id, and the server answers with a
 * fresh snapshot that REPLACES the cell's records (RecordStore.setQueryResult)
 * — no unmount, so no flicker. This is how a restroom that became premium or
 * unavailable leaves an open map: in SDK 0.39.3 the server sends nothing to a
 * socket that loses read access to a row (see CLAUDE.md, phase 2). It is the
 * same message the SDK itself re-sends for `orderBy` queries, and the
 * server's subscribe handler is stateless (it only runs the query).
 */

import { useEffect, useRef } from 'react'
import { useQuery, useRecordContext } from 'deepspace'
import type { Restroom } from '../schemas/restrooms-schema'

export type CellRecords = { records: { recordId: string; data: Restroom }[]; ready: boolean }

type Report = (cellKey: string, value: CellRecords | null) => void

export function RestroomCells({
  cellKeys,
  refreshNonce,
  onReport,
}: {
  cellKeys: string[]
  refreshNonce: number
  onReport: Report
}) {
  return (
    <>
      {cellKeys.map((key) => (
        <CellQuery key={key} cellKey={key} refreshNonce={refreshNonce} onReport={onReport} />
      ))}
    </>
  )
}

function CellQuery({ cellKey, refreshNonce, onReport }: { cellKey: string; refreshNonce: number; onReport: Report }) {
  const { records, status } = useQuery<Restroom>('restrooms', { where: { cellKey } })
  const { store, sendMessage } = useRecordContext()
  useEffect(() => {
    onReport(cellKey, { records, ready: status === 'ready' })
  }, [cellKey, records, status, onReport])
  useEffect(() => () => onReport(cellKey, null), [cellKey, onReport])

  const lastNonce = useRef(refreshNonce)
  useEffect(() => {
    if (lastNonce.current === refreshNonce) return // mounting already subscribed
    lastNonce.current = refreshNonce
    const query = { collection: 'restrooms', where: { cellKey } }
    // useQuery's key: JSON of { collection, where, orderBy, orderDir, limit }, undefined keys dropped.
    const subscriptionId = store.getSubscriptionId(JSON.stringify(query))
    if (subscriptionId) sendMessage({ type: 'core.subscribe', payload: { subscriptionId, query } })
  }, [refreshNonce, cellKey, store, sendMessage])
  return null
}
