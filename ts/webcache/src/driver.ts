export interface CacheDriver {
  /** Retrieves a raw string from the cache */
  get(key: string): Promise<string | null>

  /** Sets a value with a TTL (milliseconds) */
  set(key: string, value: string, ttlMs: number): Promise<void>

  /** Deletes a key */
  del(key: string): Promise<void>

  /** Sets a specific expiration on a key (useful for refreshing ZSets) */
  expire(key: string, ttlMs: number): Promise<void>

  /** * Tries to acquire a lock atomically (SET NX equivalent).
   * Returns true if lock was acquired, false if it already exists.
   */
  acquireLock(key: string, value: string, ttlMs: number): Promise<boolean>

  // --- ZSet Primitives ---
  zAdd(key: string, score: number, value: string): Promise<void>
  zAddMany(key: string, items: { score: number; value: string }[]): Promise<void>
  zRangeByScore(key: string, min: number, max: number): Promise<string[]>
  zRemRangeByScore(key: string, min: number, max: number): Promise<void>

  /** Replace the range in the zset with an atomic transaction 
   * Finds the min/max scores of members
   * Removes the existing members in the range
   * Adds the new members
  */
  zreplaceRange(key: string, members: { score: number; value: string }[]): Promise<void>
}
