import { CacheDriver } from "./driver"

interface CacheEntry {
  value: string
  expiresAt: number | null // null = no expiration
}

interface ZSetEntry {
  score: number
  value: string
}

/**
 * In-memory implementation of CacheDriver for local development and testing.
 * Uses lazy expiration (checks TTL on access).
 */
export class MemoryCacheDriver implements CacheDriver {
  private store = new Map<string, CacheEntry>()
  private zsets = new Map<string, ZSetEntry[]>()
  private zsetExpiry = new Map<string, number>() // Track ZSET TTLs separately

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key)
    if (!entry) return null

    // Lazy expiration check
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return null
    }

    return entry.value
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const expiresAt = ttlMs === Infinity ? null : Date.now() + ttlMs
    this.store.set(key, { value, expiresAt })
  }

  async del(key: string): Promise<void> {
    this.store.delete(key)
    this.zsets.delete(key)
    this.zsetExpiry.delete(key)
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    // For regular keys
    const entry = this.store.get(key)
    if (entry) {
      entry.expiresAt = Date.now() + ttlMs
    }

    // For ZSETs
    if (this.zsets.has(key)) {
      this.zsetExpiry.set(key, Date.now() + ttlMs)
    }
  }

  async acquireLock(key: string, value: string, ttlMs: number): Promise<boolean> {
    const existing = await this.get(key)
    if (existing !== null) {
      return false // Lock already held
    }
    await this.set(key, value, ttlMs)
    return true
  }

  // --- ZSet Operations ---

  private getZSet(key: string): ZSetEntry[] | null {
    // Check ZSET expiry
    const expiry = this.zsetExpiry.get(key)
    if (expiry !== undefined && Date.now() > expiry) {
      this.zsets.delete(key)
      this.zsetExpiry.delete(key)
      return null
    }
    return this.zsets.get(key) ?? null
  }

  async zAdd(key: string, score: number, value: string): Promise<void> {
    let entries = this.getZSet(key)
    if (!entries) {
      entries = []
      this.zsets.set(key, entries)
    }

    // Remove existing entry with same value (ZADD replaces)
    const idx = entries.findIndex((e) => e.value === value)
    if (idx !== -1) {
      entries.splice(idx, 1)
    }

    entries.push({ score, value })
    // Keep sorted by score
    entries.sort((a, b) => a.score - b.score)
  }

  async zAddMany(key: string, items: { score: number; value: string }[]): Promise<void> {
    for (const item of items) {
      await this.zAdd(key, item.score, item.value)
    }
  }

  async zRangeByScore(key: string, min: number, max: number): Promise<string[]> {
    const entries = this.getZSet(key)
    if (!entries) return []

    return entries.filter((e) => e.score >= min && e.score <= max).map((e) => e.value)
  }

  async zRemRangeByScore(key: string, min: number, max: number): Promise<void> {
    const entries = this.getZSet(key)
    if (!entries) return

    const filtered = entries.filter((e) => e.score < min || e.score > max)
    this.zsets.set(key, filtered)
  }

  // --- Test Helpers ---

  /** Clear all data (useful for test cleanup) */
  clear(): void {
    this.store.clear()
    this.zsets.clear()
    this.zsetExpiry.clear()
  }

  /** Get raw store size (useful for test assertions) */
  size(): number {
    return this.store.size + this.zsets.size
  }
}
