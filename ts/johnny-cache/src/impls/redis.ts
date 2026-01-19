import { createClient, RedisClientType } from "redis"
import { ICache, None, OnCacheErrorCallback, Option, Some, SuperJSONSerializable } from "../icache"
import * as sj from "superjson"

function safeSerialize<T>(value: SuperJSONSerializable<T>): string {
  return sj.stringify(value)
}

/**
 * Internal envelope structure for cached data.
 * Separates user data from cache metadata.
 */
type CacheEnvelope<T> = {
  data: T
  timestamp: number
}

export type RedisCacheConfig = {
  url: string
  keepAlive?: boolean
  connectTimeout?: number
  maxRetries?: number
}

const DEFAULT_KEEP_ALIVE = true
const DEFAULT_CONNECT_TIMEOUT = 10000
const DEFAULT_MAX_RETRIES = 3

const DEFAULT_CONFIG: Omit<RedisCacheConfig, "url"> = {
  keepAlive: DEFAULT_KEEP_ALIVE,
  connectTimeout: DEFAULT_CONNECT_TIMEOUT,
  maxRetries: DEFAULT_MAX_RETRIES,
}

export class RedisCache implements ICache {
  private readonly client: RedisClientType
  private isConnected = false
  private connectPromise: Promise<void> | null = null
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts: number
  onError?: OnCacheErrorCallback

  constructor(private readonly config: RedisCacheConfig, onError?: OnCacheErrorCallback) {
    this.onError = onError
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...this.config,
    }
    this.maxReconnectAttempts = mergedConfig.maxRetries!

    this.client = createClient({
      url: mergedConfig.url,
      socket: {
        keepAlive: mergedConfig.keepAlive !== undefined ? mergedConfig.keepAlive : true,
        connectTimeout: mergedConfig.connectTimeout,
        reconnectStrategy: (retries) => {
          if (retries >= this.maxReconnectAttempts) {
            console.error(`Redis reconnection failed after ${retries} attempts`)
            return new Error("Max reconnection attempts reached")
          }
          // Exponential backoff: 100ms, 200ms, 400ms, etc.
          const delay = Math.min(100 * Math.pow(2, retries), 3000)
          console.log(`Redis reconnecting in ${delay}ms (attempt ${retries + 1})`)
          return delay
        },
      },
    })

    // Set up event handlers
    this.client.on("error", (err) => {
      console.error("Redis client error:", err)
      this.isConnected = false
    })

    this.client.on("connect", () => {
      console.log("Redis client connected")
      this.isConnected = true
      this.reconnectAttempts = 0
    })

    this.client.on("reconnecting", () => {
      console.log("Redis client reconnecting...")
      this.isConnected = false
      this.reconnectAttempts++
    })

    this.client.on("end", () => {
      console.log("Redis client connection closed")
      this.isConnected = false
    })
  }

  /**
   * Ensures the Redis client is connected.
   * Uses a promise to prevent multiple simultaneous connection attempts.
   */
  async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return
    }

    // If a connection attempt is already in progress, wait for it
    if (this.connectPromise) {
      return this.connectPromise
    }

    // Start a new connection attempt
    this.connectPromise = (async () => {
      try {
        if (!this.client.isOpen) {
          await this.client.connect()
          this.isConnected = true
        }
      } catch (error) {
        console.error("Failed to connect to Redis:", error)
        throw error
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  async get<T>(key: string, maxStaleSeconds?: number): Promise<Option<T>> {
    try {
      await this.ensureConnected()
      const value = await this.client.get(key)

      if (value === null) {
        return None
      }

      const envelope = sj.parse<CacheEnvelope<T>>(value)

      // Check staleness if maxStaleSeconds is specified
      if (maxStaleSeconds !== undefined) {
        const ageSeconds = (Date.now() - envelope.timestamp) / 1000
        if (ageSeconds > maxStaleSeconds) {
          return None // Data is too stale
        }
      }

      return Some(envelope.data as T)
    } catch (error) {
      this.onError?.("get", { key }, error)
      return None // Gracefully return None on error
    }
  }

  async set<T>(key: string, value: SuperJSONSerializable<T>, ttlSeconds?: number): Promise<void> {
    try {
      await this.ensureConnected()

      // Wrap value with timestamp metadata
      const envelope: CacheEnvelope<SuperJSONSerializable<T>> = {
        data: value,
        timestamp: Date.now(),
      }

      const serialized = safeSerialize<CacheEnvelope<T>>(envelope)

      if (ttlSeconds !== undefined && ttlSeconds > 0) {
        await this.client.setEx(key, ttlSeconds, serialized)
      } else {
        await this.client.set(key, serialized)
      }
    } catch (error) {
      this.onError?.("set", { key }, error)
      // Don't throw - gracefully degrade by not caching
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.ensureConnected()
      await this.client.del(key)
    } catch (error) {
      this.onError?.("delete", { key }, error)
      // Don't throw - gracefully degrade
    }
  }

  async zadd<T>(key: string, members: Array<{ score: number; value: SuperJSONSerializable<T> }>): Promise<number> {
    try {
      await this.ensureConnected()
      const zaddArgs = members.map((m) => ({
        score: m.score,
        value: safeSerialize(m.value),
      }))
      return await this.client.zAdd(key, zaddArgs)
    } catch (error) {
      this.onError?.("zadd", { key }, error)
      return 0
    }
  }

  async zrange<T>(
    key: string,
    min: number,
    max: number,
    opts?: { order?: "asc" | "desc"; limit?: number },
  ): Promise<T[]> {
    try {
      await this.ensureConnected()
      const order = opts?.order ?? "asc"
      const limit = opts?.limit

      if (order === "desc") {
        // Use zRange with BY SCORE and REV for descending order
        const results = await this.client.zRange(key, max, min, {
          BY: "SCORE",
          REV: true,
          LIMIT: limit !== undefined ? { offset: 0, count: limit } : undefined,
        })
        return results.map((r) => sj.parse<T>(r))
      } else {
        const options = limit !== undefined ? { LIMIT: { offset: 0, count: limit } } : undefined
        const results = await this.client.zRangeByScore(key, min, max, options)
        return results.map((r) => sj.parse<T>(r))
      }
    } catch (error) {
      this.onError?.("zrange", { key }, error)
      return []
    }
  }

  async zremRangeByScore(key: string, min: number, max: number): Promise<number> {
    try {
      await this.ensureConnected()
      return await this.client.zRemRangeByScore(key, min, max)
    } catch (error) {
      this.onError?.("zremRangeByScore", { key }, error)
      return 0
    }
  }

  /**
   * Gracefully closes the Redis connection.
   * Should be called on application shutdown.
   */
  async disconnect(): Promise<void> {
    try {
      if (this.client.isOpen) {
        await this.client.quit()
        console.log("Redis client disconnected gracefully")
      }
    } catch (error) {
      console.error("Error disconnecting Redis client:", error)
      // Force close if graceful quit fails
      await this.client.disconnect()
    }
  }
}
