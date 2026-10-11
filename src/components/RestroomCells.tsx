/**
 * Loads restrooms one seeding-grid cell at a time: one `useQuery` per cell,
 * `where: { cellKey }`. Mounting a cell subscribes; unmounting unsubscribes.
 *
 * Keep these queries free of `orderBy` and `limit`: the SDK client re-sends
 * (and the server re-runs) such a query on every change to the collection,
 * while a plain `where` query just applies or drops each change locally.
 */

import { useEffect } from 'react'
import { useQuery } from 'deepspace'
import type { Restroom } from '../schemas/restrooms-schema'

export type CellRecords = { records: { recordId: string; data: Restroom }[]; ready: boolean }

type Report = (cellKey: string, value: CellRecords | null) => void

export function RestroomCells({ cellKeys, onReport }: { cellKeys: string[]; onReport: Report }) {
  return (
    <>
      {cellKeys.map((key) => (
        <CellQuery key={key} cellKey={key} onReport={onReport} />
      ))}
    </>
  )
}

function CellQuery({ cellKey, onReport }: { cellKey: string; onReport: Report }) {
  const { records, status } = useQuery<Restroom>('restrooms', { where: { cellKey } })
  useEffect(() => {
    onReport(cellKey, { records, ready: status === 'ready' })
  }, [cellKey, records, status, onReport])
  useEffect(() => () => onReport(cellKey, null), [cellKey, onReport])
  return null
}
