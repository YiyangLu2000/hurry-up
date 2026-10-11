/**
 * Minimal types for `node:async_hooks` (available in the Worker through the
 * `nodejs_compat` flag). The project does not ship @types/node.
 */
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R
    getStore(): T | undefined
  }
}
