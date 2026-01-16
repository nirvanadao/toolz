/**
 * PromiseCoalescer
 * * A specialized utility to prevent "Thundering Herds" locally.
 * If multiple concurrent calls request the same key, they will share
 * a single execution of the fetcher function.
 */
export class PromiseCoalescer {
  // Holds the pending promises.
  // We use `any` for the promise value internally, but public methods are typed.
  private inflight = new Map<string, Promise<any>>()

  /**
   * Executes the given fetcher function.
   * If a request with the same key is already pending, it returns the existing
   * promise instead of starting a new one.
   * * @param key Unique identifier for the operation (e.g., "user:123")
   * @param fetcher The async function to execute if no request is pending
   * @param timeoutMs Safety timeout to release lock if fetcher hangs (default: 30s)
   */
  public execute<T>(key: string, fetcher: () => Promise<T>, timeoutMs: number = 30000): Promise<T> {
    // 1. Check if work is already in progress
    const existingPromise = this.inflight.get(key)
    if (existingPromise) {
      return existingPromise
    }

    // 2. Start new work with Safety Timeout
    // We wrap the fetcher to ensure it doesn't hang the cache key forever.
    const promise = Promise.race([
      fetcher(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PromiseCoalescer timeout")), timeoutMs)),
    ]).finally(() => {
      // 3. Cleanup
      // Only delete if the value in the map is still THIS promise.
      // (Prevents race conditions if the map was cleared manually)
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key)
      }
    })

    // 4. Store inflight promise
    this.inflight.set(key, promise)

    return promise as Promise<T>
  }

  /**
   * Helper to check if a specific key is currently busy.
   */
  public isInflight(key: string): boolean {
    return this.inflight.has(key)
  }

  /**
   * Force clear all inflight tracking (does not cancel actual promises).
   */
  public clear(): void {
    this.inflight.clear()
  }
}
