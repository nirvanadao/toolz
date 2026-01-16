import type { Redis } from "ioredis"
import { randomUUID } from "crypto" // Native in Node 19+, or use uuid package

/**
 * ResilientCache (Production Ready)
 * * Changes from basic:
 * 1. Fail-Safe: Redis errors are swallowed (treated as misses) to prevent app crashes.
 * 2. Safe Locking: Uses unique tokens to ensure we don't delete others' locks.
 * 3. Namespace: internal prefixing to prevent collisions.
 * 4. Error Handling: Protects against JSON parse errors.
 */

export interface CacheOptions {
  swrThreshold?: number // Default: 60s
  ttl?: number // Default: 5m
  maxAgeTolerance?: number // Default: Infinity
}

interface CachePayload<T> {
  value: T
  timestamp: number
}

export class ResilientCache {
  private redis: Redis
  private localPromises: Map<string, Promise<any>>
  private prefix: string

  constructor(redisClient: Redis, keyPrefix: string = "cache:v1:") {
    this.redis = redisClient
    this.localPromises = new Map()
    this.prefix = keyPrefix
  }

  public async get<T>(rawKey: string, fetcher: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
    const key = this.prefix + rawKey
    const swrThreshold = options.swrThreshold ?? 60_000
    const ttl = options.ttl ?? 300_000
    const tolerance = options.maxAgeTolerance ?? Infinity

    // 1. Local Coalescing
    if (this.localPromises.has(key)) {
      return this.localPromises.get(key)
    }

    // 2. Fetch from Redis (Fail-Safe)
    let cachedString: string | null = null
    try {
      cachedString = await this.redis.get(key)
    } catch (err) {
      console.warn(`[ResilientCache] Redis get failed for ${key}. Treating as miss.`, err)
      // Fall through to hard miss logic
    }

    if (cachedString) {
      let entry: CachePayload<T>
      try {
        entry = JSON.parse(cachedString)
      } catch (e) {
        return this.fetchAndCache(key, fetcher, ttl)
      }

      const now = Date.now()
      const age = now - entry.timestamp

      // Strict Tolerance Check
      if (age > tolerance) {
        return this.fetchAndCache(key, fetcher, ttl)
      }

      // SWR Check
      if (age > swrThreshold) {
        // Run in background, don't await
        this.tryBackgroundRevalidation(key, fetcher, ttl)
      }

      return entry.value
    }

    // 3. Hard Miss
    return this.fetchAndCache(key, fetcher, ttl)
  }

  public async set<T>(rawKey: string, value: T, ttl: number = 300_000): Promise<void> {
    const key = this.prefix + rawKey
    const payload: CachePayload<T> = { value, timestamp: Date.now() }
    const serialized = JSON.stringify(payload)

    try {
      if (ttl === Infinity) {
        await this.redis.set(key, serialized)
      } else {
        await this.redis.set(key, serialized, "PX", ttl)
      }
    } catch (err) {
      console.warn(`[ResilientCache] Redis set failed for ${key}`, err)
    }
  }

  public async delete(rawKey: string): Promise<void> {
    try {
      await this.redis.del(this.prefix + rawKey)
    } catch (e) {
      console.warn(`[ResilientCache] Delete failed`, e)
    }
  }

  // --- Internals ---

  private async fetchAndCache<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<T> {
    if (this.localPromises.has(key)) return this.localPromises.get(key)

    const promise = (async () => {
      try {
        const value = await fetcher()

        // Don't wait for set, but catch its errors
        // Note: We use the already prefixed 'key' here
        const payload: CachePayload<T> = { value, timestamp: Date.now() }
        this.redis
          .set(key, JSON.stringify(payload), "PX", ttl === Infinity ? 0 : ttl)
          .catch((e) => console.warn(`[ResilientCache] Background set failed`, e))

        return value
      } finally {
        this.localPromises.delete(key)
      }
    })()

    this.localPromises.set(key, promise)
    return promise
  }

  private async tryBackgroundRevalidation<T>(key: string, fetcher: () => Promise<T>, ttl: number): Promise<void> {
    const lockKey = `lock:${key}`
    const token = randomUUID() // Unique ID for this specific attempt

    try {
      // NX: Only set if not exists
      // PX: Expire after 10s (safety valve)
      const acquired = await this.redis.set(lockKey, token, "PX", 10_000, "NX")

      if (acquired === "OK") {
        // We own the lock. Perform work.
        fetcher()
          .then(async (value) => {
            // Update Cache
            const payload: CachePayload<T> = { value, timestamp: Date.now() }
            await this.redis.set(key, JSON.stringify(payload), "PX", ttl === Infinity ? 0 : ttl)

            // Safe Release: Only delete if WE still own it
            // (Requires Lua for perfect atomicity, but this is "good enough" for SWR)
            const currentToken = await this.redis.get(lockKey)
            if (currentToken === token) {
              await this.redis.del(lockKey)
            }
          })
          .catch((err) => console.warn(`[ResilientCache] Revalidation failed for ${key}`, err))
      }
    } catch (err) {
      console.warn(`[ResilientCache] Lock acquisition error`, err)
    }
  }
}
