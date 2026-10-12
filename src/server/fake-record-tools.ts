/**
 * In-memory stand-in for the RBAC-bypassing record tools, for unit tests.
 * Supports what the score code uses: get, create (upsert-merge), update
 * (merge, fails when missing), and query with equality `where`.
 *
 * `afterRead` runs after every read has taken its snapshot and before it
 * returns; tests use it to land another user's write in the middle of an
 * action, the way a concurrent request would.
 */

import type { ActionTools } from 'deepspace/worker'

type Store = Record<string, Map<string, Record<string, unknown>>>

export function fakeRecordTools() {
  const store: Store = {}
  const table = (name: string) => (store[name] ??= new Map())
  const hooks: { afterRead?: (collection: string) => void | Promise<void> } = {}
  const calls = { reads: 0, writes: 0 }

  const afterRead = async (collection: string) => {
    calls.reads++
    await hooks.afterRead?.(collection)
  }

  const tools = {
    get: async (collection: string, id: string) => {
      const data = table(collection).get(id)
      const result = data
        ? { success: true, data: { record: { recordId: id, data: { ...data } } } }
        : { success: false, error: 'not found' }
      await afterRead(collection)
      return result
    },
    query: async (collection: string, options?: { where?: Record<string, unknown> }) => {
      const where = options?.where ?? {}
      const records = [...table(collection)]
        .filter(([, data]) => Object.entries(where).every(([k, v]) => data[k] === v))
        .map(([recordId, data]) => ({ recordId, data: { ...data } }))
      await afterRead(collection)
      return { success: true, data: { records, count: records.length } }
    },
    create: async (collection: string, data: Record<string, unknown>, id: string) => {
      calls.writes++
      table(collection).set(id, { ...table(collection).get(id), ...data })
      return { success: true, data: { recordId: id } }
    },
    update: async (collection: string, id: string, data: Record<string, unknown>) => {
      calls.writes++
      const existing = table(collection).get(id)
      if (!existing) return { success: false, error: 'not found' }
      table(collection).set(id, { ...existing, ...data })
      return { success: true, data: { recordId: id } }
    },
  }

  return { tools: tools as unknown as ActionTools, table, hooks, calls }
}
