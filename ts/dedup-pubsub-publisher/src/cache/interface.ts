export enum MessageState {
  PENDING = "pending",
  PUBLISHED = "published",
}

/**
 * Contract for a deduplication cache.
 * Implementations must be atomic (use SETNX or equivalent).
 */
export interface IDedupCache {
  connect(): Promise<void>
  disconnect(): Promise<void>

  /** Atomically set key to PENDING if not exists. Returns true if set. */
  setIfNotExists(key: string, ttlSeconds?: number): Promise<boolean>

  /** Get current state of key, or null if not exists. */
  getState(key: string): Promise<MessageState | null>

  /** Mark key as PUBLISHED (overwrites PENDING). */
  markPublished(key: string, ttlSeconds?: number): Promise<void>

  /** Check if key exists. */
  exists(key: string): Promise<boolean>

  /** Batch check for multiple keys. Returns set of keys that exist. */
  existsMultiple(keys: string[]): Promise<Set<string>>

  /** Delete a key. */
  delete(key: string): Promise<void>

  /** Get hit/miss stats. */
  getStats(): Promise<{ hits: number; misses: number }>
}
