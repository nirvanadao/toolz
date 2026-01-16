import { CacheDriver } from "./driver"
import { PromiseCoalescer } from "./promise_coalescer"
import { randomUUID } from "crypto"
import superjson from "superjson"

interface CachePayload<T> {
  value: T
  timestamp: number
}

export interface CacheOptions {
  swrThreshold?: number // Default: 60s
  ttl?: number // Default: 5m
  maxAgeTolerance?: number // Default: Infinity
}

export class ResilientCache {
  private driver: CacheDriver
  public coalescer: PromiseCoalescer // Public so you can coalesce custom zRange ops
  private prefix: string

  constructor(driver: CacheDriver, keyPrefix: string = "cache:v1:") {
    this.driver = driver
    this.coalescer = new PromiseCoalescer()
    this.prefix = keyPrefix
  }

  // --- Key/Value Operations ---

  public async get<T>(rawKey: string, fetcher: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
    const key = this.prefix + rawKey
    const swrThreshold = options.swrThreshold ?? 60_000
    const ttl = options.ttl ?? 300_000
    const tolerance = options.maxAgeTolerance ?? Infinity

    // 1. Fetch from Driver (Fail-Safe)
    let cachedString: string | null = null
    try {
      cachedString = await this.driver.get(key)
    } catch (err) {
      console.warn(`[ResilientCache] Driver get failed for ${key}. Treating as miss.`, err)
    }

    if (cachedString) {
      let entry: CachePayload<T>
      try {
        // Use SuperJSON to deserialize (restores Dates, Sets, Maps)
        entry = superjson.parse(cachedString)
      } catch (e) {
        // Corrupt data -> Fetch fresh
        return this.fetchAndCache(key, fetcher, ttl)
      }

      const now = Date.now()
      const age = now - entry.timestamp

      // A. Strict Tolerance Check (Client rejects old data)
      if (age > tolerance) {
        return this.fetchAndCache(key, fetcher, ttl)
      }

      // B. SWR Check (Data is stale, but usable)
      if (age > swrThreshold) {
        this.tryBackgroundRevalidation(key, fetcher, ttl)
      }

      return entry.value
    }

    // 2. Hard Miss
    return this.fetchAndCache(key, fetcher, ttl)
  }

  public async set<T>(rawKey: string, value: T, ttl: number = 300_000): Promise<void> {
    const key = this.prefix + rawKey
    const payload: CachePayload<T> = { value, timestamp: Date.now() }
    this.safeSet(key, payload, ttl)
  }

  public async delete(rawKey: string): Promise<void> {
    try {
      await this.driver.del(this.prefix + rawKey)
    } catch (e) {
      console.warn(`[ResilientCache] Delete failed`, e)
    }
  }

  // --- Sorted Set (ZSET) Operations ---

  public async zAdd<T>(rawKey: string, item: T, score: number, ttlMs?: number): Promise<void> {
    const key = this.prefix + rawKey
    try {
      const serialized = superjson.stringify(item)
      await this.driver.zAdd(key, score, serialized)
      if (ttlMs) await this.driver.expire(key, ttlMs)
    } catch (e) {
      console.warn(`[ResilientCache] zAdd failed for ${key}`, e)
    }
  }

  public async zAddMany<T>(
    rawKey: string,
    items: T[],
    scoreMapper: (item: T) => number,
    ttlMs?: number,
  ): Promise<void> {
    const key = this.prefix + rawKey
    if (items.length === 0) return

    try {
      const batch = items.map((item) => ({
        score: scoreMapper(item),
        value: superjson.stringify(item),
      }))
      await this.driver.zAddMany(key, batch)
      if (ttlMs) await this.driver.expire(key, ttlMs)
    } catch (e) {
      console.warn(`[ResilientCache] zAddMany failed for ${key}`, e)
    }
  }

  public async zRange<T>(rawKey: string, minScore: number, maxScore: number): Promise<T[]> {
    const key = this.prefix + rawKey
    try {
      const results = await this.driver.zRangeByScore(key, minScore, maxScore)
      return results.map((str) => superjson.parse(str) as T)
    } catch (e) {
      console.warn(`[ResilientCache] zRange failed for ${key}`, e)
      return []
    }
  }

  public async zRemRange(rawKey: string, minScore: number, maxScore: number): Promise<void> {
    const key = this.prefix + rawKey
    try {
      await this.driver.zRemRangeByScore(key, minScore, maxScore)
    } catch (e) {
      console.warn(`[ResilientCache] zRemRange failed for ${key}`, e)
    }
  }

  // --- Internals ---

  private async fetchAndCache<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<T> {
    // 1. Coalesce: Prevent local stampedes for the same key
    return this.coalescer.execute(key, async () => {
      // 2. Fetch
      const value = await fetcher()

      // 3. Cache (Background)
      const payload: CachePayload<T> = { value, timestamp: Date.now() }
      // We don't await the set, but we catch errors
      this.safeSet(key, payload, ttl)

      return value
    })
  }

  private async tryBackgroundRevalidation<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<void> {
    const lockKey = `lock:${key}`
    const token = randomUUID()

    try {
      // 1. Acquire Lock (fail fast if taken)
      const acquired = await this.driver.acquireLock(lockKey, token, 10_000)

      if (acquired) {
        // 2. Perform work (Coalesced!)
        this.coalescer
          .execute(key, fetcher)
          .then((value) => {
            const payload: CachePayload<T> = { value, timestamp: Date.now() }
            return this.safeSet(key, payload, ttl)
          })
          .then(async () => {
            // 3. Release Lock (Optimistic)
            await this.driver.del(lockKey).catch(() => {})
          })
          .catch((err) => console.warn(`[ResilientCache] Revalidation failed for ${key}`, err))
      }
    } catch (err) {
      console.warn(`[ResilientCache] Lock error`, err)
    }
  }

  /** Helper to handle serialization and driver errors */
  private async safeSet<T>(key: string, payload: CachePayload<T>, ttl: number): Promise<void> {
    try {
      const serialized = superjson.stringify(payload)
      await this.driver.set(key, serialized, ttl)
    } catch (err) {
      console.warn(`[ResilientCache] SafeSet failed for ${key}`, err)
    }
  }
}
