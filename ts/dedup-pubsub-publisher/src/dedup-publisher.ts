import { createHash } from "crypto"
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
import { IDedupCache } from "./cache/interface"

/**
 * Contract for a publisher that DedupPublisher wraps.
 * Compatible with PubSubPublisher from @nirvana-tools/pubsub-publisher.
 */
export interface IPublisher {
  publish(data: Buffer): Promise<string>
  stop(): Promise<void>
}

export type DedupPublisherStats = {
  published: number
  deduplicated: number
  failed: number
}

/** Function that generates a cache key from message data */
export type CacheKeyFn = (data: Buffer) => string

export type DedupPublisherArgs = {
  publisher: IPublisher
  cache: IDedupCache
  logger: CloudRunLogger
  /** Custom cache key generator. Defaults to SHA-256 hex hash. */
  toCacheKey?: CacheKeyFn
}

/**
 * Wraps a publisher with Redis-backed deduplication using two-phase commit:
 * 1. Set cache key to PENDING (claim)
 * 2. Publish message
 * 3. Set cache key to PUBLISHED (confirm)
 *
 * On failure: deletes cache key so caller can retry.
 */
export class DedupPublisher {
  private publisher: IPublisher
  private cache: IDedupCache
  private logger: CloudRunLogger
  private toCacheKey: CacheKeyFn
  private stats: DedupPublisherStats = { published: 0, deduplicated: 0, failed: 0 }

  constructor({ publisher, cache, logger, toCacheKey }: DedupPublisherArgs) {
    this.publisher = publisher
    this.cache = cache
    this.logger = logger
    this.toCacheKey = toCacheKey ?? DedupPublisher.sha256
  }

  /** Default: SHA-256 hash of data as hex string */
  static sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex")
  }

  async connect(): Promise<void> {
    await this.cache.connect()
  }

  async stop(): Promise<void> {
    try {
      await this.publisher.stop()
    } catch (error) {
      this.logger.error("Error stopping publisher", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    try {
      await this.cache.disconnect()
    } catch (error) {
      this.logger.error("Error disconnecting cache", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Publish with deduplication. Skips if already published or in progress.
   * Throws on publish failure (caller should retry).
   */
  async publish(data: Buffer): Promise<void> {
    const key = this.toCacheKey(data)

    const claimed = await this.tryToClaim(key)
    if (!claimed) {
      this.stats.deduplicated++
      return
    }

    // Step 1: Publish
    try {
      await this.publisher.publish(data)
    } catch (error) {
      this.stats.failed++
      this.logger.error("Publish failed", { key })
      await this.cleanupFailedClaim(key)
      throw error
    }

    // Step 2: Mark as published (best effort - message is already sent)
    try {
      await this.cache.markPublished(key)
    } catch (error) {
      // Don't cleanup! Message was published. Leave as PENDING to prevent duplicates.
      // Key will be deduped on retry or expire via TTL.
      this.logger.error("Failed to mark as published (message WAS sent)", { key })
    }

    this.stats.published++
  }

  private async tryToClaim(key: string): Promise<boolean> {
    const wasNew = await this.cache.setIfNotExists(key)
    if (wasNew) return true

    // Key exists - check state
    const state = await this.cache.getState(key)
    if (!state) {
      // Rare: key expired between checks, retry
      this.logger.warn("Cache key disappeared, retrying", { key })
      return this.tryToClaim(key)
    }

    // PENDING or PUBLISHED - skip either way
    return false
  }

  private async cleanupFailedClaim(key: string): Promise<void> {
    try {
      await this.cache.delete(key)
    } catch (error) {
      this.logger.error("Failed to cleanup PENDING key after publish failure", {
        key,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  getStats(): DedupPublisherStats {
    return { ...this.stats }
  }
}
