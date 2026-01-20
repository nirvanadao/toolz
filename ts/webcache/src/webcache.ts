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

export type ZSetOperation = "zAdd" | "zAddMany" | "zRange" | "zRemRange" | "zReplaceRange"

export interface CacheMetrics {
  /** Called when returning a cached value (fresh or stale) */
  onHit?: (key: string, ageMs: number) => void
  /** Called when fetching fresh data (cache miss) */
  onMiss?: (key: string) => void
  /** Called when serving stale data and triggering background refresh */
  onStaleRevalidate?: (key: string, ageMs: number) => void
  /** Called when driver errors or corrupt data encountered */
  onError?: (key: string, error: unknown) => void
  /** Called when background refresh skipped because another instance holds the lock */
  onLockContention?: (key: string) => void
  /** Called when background refresh completes */
  onBackgroundRefresh?: (key: string, durationMs: number, success: boolean) => void
  /** Called when lock is released (stillOwned=true means we still held it) */
  onLockReleased?: (key: string, stillOwned: boolean) => void
  /** Called when a ZSET operation completes */
  onZSetOperation?: (key: string, operation: ZSetOperation, durationMs: number, success: boolean) => void
}

export interface WebCacheOptions {
  logger?: ILogger
  keyPrefix: string
  driver: CacheDriver
  metrics?: CacheMetrics
  /** Default timeout for promise coalescing (default: 30s) */
  coalescerTimeoutMs?: number
  /** Timeout for background revalidation fetches (default: same as coalescerTimeoutMs) */
  backgroundFetchTimeoutMs?: number
  /** TTL for the distributed lock during background refresh (default: 30s) */
  backgroundRefreshLockTtlMs?: number
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
  private _driver: CacheDriver
  public coalescer: PromiseCoalescer // Public so you can coalesce custom zRange ops
  private prefix: string
  private log: ILogger
  private metrics?: CacheMetrics
  private backgroundFetchTimeoutMs?: number
  private backgroundRefreshLockTtlMs: number

  constructor(options: WebCacheOptions) {
    this._driver = options.driver
    this.coalescer = new PromiseCoalescer({
      defaultTimeoutMs: options.coalescerTimeoutMs,
    })
    this.prefix = options.keyPrefix
    this.log = options.logger ?? new ConsoleLogger()
    this.metrics = options.metrics
    this.backgroundFetchTimeoutMs = options.backgroundFetchTimeoutMs
    this.backgroundRefreshLockTtlMs = options.backgroundRefreshLockTtlMs ?? 30_000
  }

  get driver(): CacheDriver {
    return this._driver
  }

  /** Prepends the configured prefix to a raw key */
  private namespaceKey(rawKey: string): string {
    return this.prefix + rawKey
  }

  // --- Key/Value Operations ---

  public async get<T, E = Error>(
    rawKey: string,
    fetcher: Fetcher<T, E>,
    options: CacheOptions = {},
  ): Promise<Result<T, E>> {
    const key = this.namespaceKey(rawKey)
    const swrThreshold = options.swrThreshold ?? 60_000
    const ttl = options.ttl ?? 300_000
    const tolerance = options.maxAgeTolerance ?? Infinity

    // 1. Fetch from Driver (Fail-Safe)
    let cachedString: string | null = null
    try {
      cachedString = await this.driver.get(key)
    } catch (err) {
      this.log.warn(`Driver get failed for ${key}. Treating as miss.`, { error: err })
      this.metrics?.onError?.(rawKey, err)
    }

    if (cachedString) {
      let entry: CachePayload<T>
      try {
        // Use SuperJSON to deserialize (restores Dates, Sets, Maps)
        entry = superjson.parse(cachedString)
      } catch (e) {
        // Corrupt data -> Fetch fresh
        this.metrics?.onError?.(rawKey, e)
        this.metrics?.onMiss?.(rawKey)
        return this.fetchAndCache(rawKey, fetcher, ttl)
      }

      const now = Date.now()
      const age = now - entry.timestamp

      // A. Strict Tolerance Check (Client rejects old data)
      if (age > tolerance) {
        this.metrics?.onMiss?.(rawKey)
        return this.fetchAndCache(rawKey, fetcher, ttl)
      }

      // B. SWR Check (Data is stale, but usable)
      if (age > swrThreshold) {
        this.metrics?.onStaleRevalidate?.(rawKey, age)
        this.tryBackgroundRevalidation(rawKey, fetcher, ttl)
      }

      this.metrics?.onHit?.(rawKey, age)
      return Ok(entry.value)
    }

    // 2. Hard Miss
    this.metrics?.onMiss?.(rawKey)
    return this.fetchAndCache(rawKey, fetcher, ttl)
  }

  public async set<T>(rawKey: string, value: T, ttl: number = 300_000): Promise<void> {
    const key = this.namespaceKey(rawKey)
    const payload: CachePayload<T> = { value, timestamp: Date.now() }
    await this.safeSet(key, payload, ttl)
  }

  public async delete(rawKey: string): Promise<void> {
    const key = this.namespaceKey(rawKey)
    try {
      await this.driver.del(key)
    } catch (e) {
      this.log.warn(`Delete failed for ${key}`, { error: e })
    }
  }

  /**
   * Proactively refresh a cache key by fetching fresh data.
   * Useful for webhook-triggered invalidation where you want fresh data immediately.
   */
  public async refresh<T, E = Error>(
    rawKey: string,
    fetcher: Fetcher<T, E>,
    options: CacheOptions = {},
  ): Promise<Result<T, E>> {
    const ttl = options.ttl ?? 300_000
    return this.fetchAndCache(rawKey, fetcher, ttl)
  }

  // --- Sorted Set (ZSET) Operations ---

  public async zAdd<T>(rawKey: string, item: T, score: number, ttlMs?: number): Promise<void> {
    const key = this.namespaceKey(rawKey)
    const startTime = Date.now()
    try {
      const serialized = superjson.stringify(item)
      await this.driver.zAdd(key, score, serialized)
      if (ttlMs) await this.driver.expire(key, ttlMs)
      this.metrics?.onZSetOperation?.(rawKey, "zAdd", Date.now() - startTime, true)
    } catch (e) {
      this.metrics?.onZSetOperation?.(rawKey, "zAdd", Date.now() - startTime, false)
      this.log.warn(`zAdd failed for ${key}`, { error: e })
    }
  }

  public async zAddMany<T>(
    rawKey: string,
    items: T[],
    scoreMapper: (item: T) => number,
    ttlMs?: number,
  ): Promise<void> {
    const key = this.namespaceKey(rawKey)
    if (items.length === 0) return

    const startTime = Date.now()
    try {
      const batch = items.map((item) => ({
        score: scoreMapper(item),
        value: superjson.stringify(item),
      }))
      await this.driver.zAddMany(key, batch)
      if (ttlMs) await this.driver.expire(key, ttlMs)
      this.metrics?.onZSetOperation?.(rawKey, "zAddMany", Date.now() - startTime, true)
    } catch (e) {
      this.metrics?.onZSetOperation?.(rawKey, "zAddMany", Date.now() - startTime, false)
      this.log.warn(`zAddMany failed for ${key}`, { error: e })
    }
  }

  public async zRange<T>(rawKey: string, minScore: number, maxScore: number, options?: { order: "asc" | "desc" }): Promise<T[]> {
    const key = this.namespaceKey(rawKey)
    const startTime = Date.now()
    try {
      const results = await this.driver.zRangeByScore(key, minScore, maxScore, options)
      this.metrics?.onZSetOperation?.(rawKey, "zRange", Date.now() - startTime, true)
      return results.map((str) => superjson.parse(str) as T)
    } catch (e) {
      this.metrics?.onZSetOperation?.(rawKey, "zRange", Date.now() - startTime, false)
      this.log.warn(`zRange failed for ${key}`, { error: e })
      return []
    }
  }

  public async zRemRange(rawKey: string, minScore: number, maxScore: number): Promise<void> {
    const key = this.namespaceKey(rawKey)
    const startTime = Date.now()
    try {
      await this.driver.zRemRangeByScore(key, minScore, maxScore)
      this.metrics?.onZSetOperation?.(rawKey, "zRemRange", Date.now() - startTime, true)
    } catch (e) {
      this.metrics?.onZSetOperation?.(rawKey, "zRemRange", Date.now() - startTime, false)
      this.log.warn(`zRemRange failed for ${key}`, { error: e })
    }
  }

  public async zreplaceRange<T>(rawKey: string, members: T[], scoreMapper: (item: T) => number): Promise<void> {
    const key = this.namespaceKey(rawKey)
    const startTime = Date.now()
    try {
      const batch = members.map((item) => ({
        score: scoreMapper(item),
        value: superjson.stringify(item),
      }))
      await this.driver.zreplaceRange(key, batch)
      this.metrics?.onZSetOperation?.(rawKey, "zReplaceRange", Date.now() - startTime, true)
    } catch (e) {
      this.metrics?.onZSetOperation?.(rawKey, "zReplaceRange", Date.now() - startTime, false)
      this.log.warn(`zreplaceRange failed for ${key}`, { error: e })
    }
  }

  // --- Internals ---

  private async fetchAndCache<T, E>(rawKey: string, fetcher: Fetcher<T, E>, ttl: number): Promise<Result<T, E>> {
    const key = this.namespaceKey(rawKey)
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

  private async tryBackgroundRevalidation<T, E>(rawKey: string, fetcher: Fetcher<T, E>, ttl: number): Promise<void> {
    const key = this.namespaceKey(rawKey)
    const lockKey = this.namespaceKey(`lock:${rawKey}`)
    const token = randomUUID()

    try {
      // 1. Acquire Lock (fail fast if taken)
      const acquired = await this.driver.acquireLock(lockKey, token, this.backgroundRefreshLockTtlMs)

      if (!acquired) {
        this.metrics?.onLockContention?.(rawKey)
        return
      }

      const startTime = Date.now()

      // 2. Perform work (Coalesced!)
      this.coalescer
        .execute(key, fetcher, this.backgroundFetchTimeoutMs)
        .then((result) => {
          const durationMs = Date.now() - startTime
          const success = !result.err
          this.metrics?.onBackgroundRefresh?.(rawKey, durationMs, success)

          // Only cache if value is Ok
          if (result.err) {
            this.log.warn(`Revalidation failed for ${key}`, { error: result.err })
            return
          }

          const payload: CachePayload<T> = { value: result.val, timestamp: Date.now() }
          return this.safeSet(key, payload, ttl)
        })
        .catch((err) => {
          const durationMs = Date.now() - startTime
          this.metrics?.onBackgroundRefresh?.(rawKey, durationMs, false)
          this.log.warn(`Revalidation failed for ${key}`, { error: err })
        })
        .finally(() => {
          // 3. Release Lock (Token-verified - only release if we still own it)
          this.driver.releaseLock(lockKey, token)
            .then((released) => {
              this.metrics?.onLockReleased?.(rawKey, released)
              if (!released) {
                this.log.debug(`Lock ${lockKey} not released (expired or taken by another instance)`)
              }
            })
            .catch((err) => {
              this.metrics?.onLockReleased?.(rawKey, false)
              this.log.warn(`Lock release error for ${lockKey}`, { error: err })
            })
        })
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
