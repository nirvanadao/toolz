import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
import { IDedupCache, MessageState } from "./interface"

export type RedisDedupCacheConfig = {
  redisUrl: string
  /** TTL in seconds for cache keys */
  ttlSeconds?: number
  /** Prefix for all keys (e.g., "dedup:") */
  keyPrefix: string
  logger: CloudRunLogger
}

/**
 * Redis-backed deduplication cache using atomic SETNX.
 * Fails closed (throws) on Redis errors to prevent duplicate storms.
 */
export class RedisDedupCache implements IDedupCache {
  private client: any
  private config: RedisDedupCacheConfig
  private isConnected = false
  private stats = { hits: 0, misses: 0 }

  constructor(config: RedisDedupCacheConfig) {
    this.config = config
    this.config.logger.info("Redis cache initialized", {
      redisUrl: config.redisUrl,
      ttlSeconds: config.ttlSeconds ?? 7 * 60, // 7 minutes
      keyPrefix: config.keyPrefix,
    })
  }

  async connect(): Promise<void> {
    if (this.isConnected) return

    const { createClient } = await import("redis")
    this.client = createClient({ url: this.config.redisUrl })

    this.client.on("error", (err: Error) => {
      this.config.logger.error("Redis error", { error: err.message })
    })

    await this.client.connect()
    this.isConnected = true
    this.config.logger.info("Connected to Redis")
  }

  async disconnect(): Promise<void> {
    if (this.isConnected && this.client) {
      await this.client.quit()
      this.isConnected = false
      this.config.logger.info("Disconnected from Redis")
    }
  }

  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error("Redis not connected. Call connect() first.")
    }
  }

  private key(k: string): string {
    return `${this.config.keyPrefix}${k}`
  }

  async setIfNotExists(key: string, ttlSeconds?: number): Promise<boolean> {
    this.ensureConnected()
    const ttl = ttlSeconds ?? this.config.ttlSeconds

    const result = await this.client.set(this.key(key), MessageState.PENDING, {
      EX: ttl,
      NX: true,
    })

    if (result === "OK") {
      this.stats.misses++
      return true
    }
    this.stats.hits++
    return false
  }

  async getState(key: string): Promise<MessageState | null> {
    this.ensureConnected()
    const value = await this.client.get(this.key(key))

    if (value === null) {
      this.stats.misses++
      return null
    }

    this.stats.hits++
    if (value === MessageState.PENDING || value === MessageState.PUBLISHED) {
      return value as MessageState
    }

    this.config.logger.warn("Unknown cache state", { key, value })
    return null
  }

  async markPublished(key: string, ttlSeconds?: number): Promise<void> {
    this.ensureConnected()
    const ttl = ttlSeconds ?? this.config.ttlSeconds
    await this.client.set(this.key(key), MessageState.PUBLISHED, { EX: ttl })
  }

  async exists(key: string): Promise<boolean> {
    this.ensureConnected()
    const result = await this.client.exists(this.key(key))
    if (result === 1) {
      this.stats.hits++
      return true
    }
    this.stats.misses++
    return false
  }

  async existsMultiple(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set()
    this.ensureConnected()

    const pipeline = this.client.multi()
    for (const k of keys) {
      pipeline.exists(this.key(k))
    }
    const results = await pipeline.exec()

    const existing = new Set<string>()
    results.forEach((result: number, i: number) => {
      if (result === 1) {
        existing.add(keys[i])
        this.stats.hits++
      } else {
        this.stats.misses++
      }
    })
    return existing
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected()
    await this.client.del(this.key(key))
  }

  async getStats(): Promise<{ hits: number; misses: number }> {
    return { ...this.stats }
  }
}
