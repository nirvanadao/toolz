import { Ok, Result } from "ts-results"
import { CacheDriver } from "./driver"
import { ConsoleLogger, ILogger } from "./logger"
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

export interface WebCacheOptions {
  logger?: ILogger
  keyPrefix: string
  driver: CacheDriver
}

export type Fetcher<T, E = Error> = () => Promise<Result<T, E>>

/**
 * Main module
 *
 * Encapsulates the core logic for a "get or do work" cache.
 *
 * - Handles SWR (Stale-While-Revalidate)
 * - Handles TTL (Time-To-Live)
 * - Handles Max Age Tolerance
 * - Distributed lock for background refresh
 */
export class WebCache {
  private driver: CacheDriver
  public coalescer: PromiseCoalescer // Public so you can coalesce custom zRange ops
  private prefix: string
  private log: ILogger

  constructor(options: WebCacheOptions) {
    this.driver = options.driver
    this.coalescer = new PromiseCoalescer()
    this.prefix = options.keyPrefix
    this.log = options.logger ?? new ConsoleLogger()
  }

  // --- Key/Value Operations ---

  public async get<T, E = Error>(
    rawKey: string,
    fetcher: Fetcher<T, E>,
    options: CacheOptions = {},
  ): Promise<Result<T, E>> {
    const key = this.prefix + rawKey
    const swrThreshold = options.swrThreshold ?? 60_000
    const ttl = options.ttl ?? 300_000
    const tolerance = options.maxAgeTolerance ?? Infinity

    // 1. Fetch from Driver (Fail-Safe)
    let cachedString: string | null = null
    try {
      cachedString = await this.driver.get(key)
    } catch (err) {
      this.log.warn(`Driver get failed for ${key}. Treating as miss.`, { error: err })
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

      return Ok(entry.value)
    }

    // 2. Hard Miss
    return this.fetchAndCache(key, fetcher, ttl)
  }

  public async set<T>(rawKey: string, value: T, ttl: number = 300_000): Promise<void> {
    const key = this.prefix + rawKey
    const payload: CachePayload<T> = { value, timestamp: Date.now() }
    await this.safeSet(key, payload, ttl)
  }

  public async delete(rawKey: string): Promise<void> {
    try {
      await this.driver.del(this.prefix + rawKey)
    } catch (e) {
      this.log.warn(`Delete failed`, { error: e })
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
      this.log.warn(`zAdd failed for ${key}`, { error: e })
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
      this.log.warn(`zAddMany failed for ${key}`, { error: e })
    }
  }

  public async zRange<T>(rawKey: string, minScore: number, maxScore: number): Promise<T[]> {
    const key = this.prefix + rawKey
    try {
      const results = await this.driver.zRangeByScore(key, minScore, maxScore)
      return results.map((str) => superjson.parse(str) as T)
    } catch (e) {
      this.log.warn(`zRange failed for ${key}`, { error: e })
      return []
    }
  }

  public async zRemRange(rawKey: string, minScore: number, maxScore: number): Promise<void> {
    const key = this.prefix + rawKey
    try {
      await this.driver.zRemRangeByScore(key, minScore, maxScore)
    } catch (e) {
      this.log.warn(`zRemRange failed for ${key}`, { error: e })
    }
  }

  // --- Internals ---

  private async fetchAndCache<T, E>(key: string, fetcher: Fetcher<T, E>, ttl: number): Promise<Result<T, E>> {
    // 1. Coalesce: Prevent local stampedes for the same key
    return this.coalescer.execute(key, async () => {
      // 2. Fetch
      const result = await fetcher()

      // Only cache if value is Ok
      if (result.err) {
        return result
      }

      // 3. Cache (Background)
      const payload: CachePayload<T> = { value: result.val, timestamp: Date.now() }
      // We don't await the set, but we catch errors
      this.safeSet(key, payload, ttl)

      return result
    })
  }

  private async tryBackgroundRevalidation<T, E>(key: string, fetcher: Fetcher<T, E>, ttl: number): Promise<void> {
    const lockKey = `lock:${key}`
    const token = randomUUID()

    try {
      // 1. Acquire Lock (fail fast if taken)
      const acquired = await this.driver.acquireLock(lockKey, token, 10_000)

      if (acquired) {
        // 2. Perform work (Coalesced!)
        this.coalescer
          .execute(key, fetcher)
          .then((result) => {
            // Only cache if value is Ok
            if (result.err) {
              this.log.warn(`Revalidation failed for ${key}`, { error: result.err })
              return
            }

            const payload: CachePayload<T> = { value: result.val, timestamp: Date.now() }
            return this.safeSet(key, payload, ttl)
          })
          .then(async () => {
            // 3. Release Lock (Optimistic)
            await this.driver.del(lockKey).catch(() => {})
          })
          .catch((err) => this.log.warn(`Revalidation failed for ${key}`, { error: err }))
      }
    } catch (err) {
      this.log.warn(`Lock error`, { error: err })
    }
  }

  /** Helper to handle serialization and driver errors */
  private async safeSet<T>(key: string, payload: CachePayload<T>, ttl: number): Promise<void> {
    try {
      const serialized = superjson.stringify(payload)
      await this.driver.set(key, serialized, ttl)
    } catch (err) {
      this.log.warn(`SafeSet failed for ${key}`, { error: err })
    }
  }
}
