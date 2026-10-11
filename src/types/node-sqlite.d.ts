/**
 * Minimal types for Node's built-in `node:sqlite`, used only by unit tests
 * that run the SDK's SQL against real SQLite. The project does not ship
 * @types/node (the app targets Workers), so only what the tests call is here.
 */
declare module 'node:sqlite' {
  type SqlValue = string | number | null
  interface StatementSync {
    all(...params: SqlValue[]): Record<string, SqlValue>[]
    run(...params: SqlValue[]): unknown
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
  }
}
