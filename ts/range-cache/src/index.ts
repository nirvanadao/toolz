import { ICache, SuperJSONSerializable, CacheWrapper } from "@nirvana-tools/johnny-cache"
import { Ok } from "ts-results"

// Re-export for convenience
export { ICache, SuperJSONSerializable }
export { Ok } from "ts-results"

// ============================================================================
// Types
// ============================================================================

/** Base interface for any bucket data type. Requires unix timestamp for ZSET scoring. */
export interface Bucket {
  unixTimestampSeconds: number
}

/**
 * Configuration for a RangeCache instance.
 * T must be JSON-serializable (no functions, promises, etc.) for caching to work.
 */
export interface RangeCacheConfig<T extends Bucket, TKey> {
  /** Operation name for logging (e.g., "candles", "marketVolume") */
  opName: string

  /** ZSET cache key generator */
  cacheKey: (key: TKey) => string

  /** Bucket width in seconds (3600 for hourly, variable for candles) */
  bucketWidthSeconds: number

  /** Query the earliest timestamp for this entity from DB. Returns unix seconds or null if no data. */
  queryEarliestTimestamp: (key: TKey) => Promise<number | null>

  /** Get nearest bucket at or before timestamp (to seed gap filling). Returns null if nothing before. */
  getNearestBeforeOrEqualTo: (key: TKey, timestampSeconds: number) => Promise<T | null>

  /** Query buckets from the database for the given range. */
  queryBucketsFromDb: (key: TKey, start: Date, end: Date) => Promise<T[]>

  /** Generate gap-filled bucket from previous. Previous is always non-null. */
  fillGap: (unixTimestampSeconds: number, previous: T) => T

  /** DB query cache key for deduplication */
  dbQueryCacheKey: (key: TKey, start: Date, end: Date) => string
}

/** Dependencies injected into RangeCache */
export interface RangeCacheDeps {
  cache: ICache
}

// ============================================================================
// Utilities
// ============================================================================

/** Align timestamp down to bucket boundary */
export function alignToBucketFloor(timestampSeconds: number, bucketIntervalSeconds: number): number {
  return Math.floor(timestampSeconds / bucketIntervalSeconds) * bucketIntervalSeconds
}

/** Align timestamp up to next bucket boundary */
export function alignToBucketCeil(timestampSeconds: number, bucketIntervalSeconds: number): number {
  return Math.ceil(timestampSeconds / bucketIntervalSeconds) * bucketIntervalSeconds
}

/** Calculate expected bucket count for an aligned range */
export function expectedBucketCount(
  alignedStartSeconds: number,
  alignedEndSeconds: number,
  bucketIntervalSeconds: number,
): number {
  if (alignedEndSeconds <= alignedStartSeconds) return 0
  return (alignedEndSeconds - alignedStartSeconds) / bucketIntervalSeconds
}

/** Get current bucket start */
export function getCurrentBucketStart(bucketIntervalSeconds: number): Date {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const alignedSeconds = alignToBucketFloor(nowSeconds, bucketIntervalSeconds)
  return new Date(alignedSeconds * 1000)
}

// ============================================================================
// RangeCache
// ============================================================================

const EARLIEST_TTL_SECONDS = 5 * 60 // 5 minutes
const DB_QUERY_TTL_SECONDS = 5 // 5 seconds

/**
 * Utility type to verify a bucket type is JSON-serializable at compile time.
 * Usage: type MyBucket = AssertSerializable<{ unixTimestampSeconds: number, value: number }>
 * If the type contains functions/promises, this resolves to `never`.
 */
export type AssertSerializable<T extends Bucket> = T extends SuperJSONSerializable<T> ? T : never

/**
 * Generic ZSET-based time-series range cache.
 *
 * Handles the common pattern of:
 * 1. Caching closed (historical) buckets in Redis ZSET
 * 2. Always fetching open (current) bucket from DB
 * 3. Filling gaps to ensure dense bucket arrays
 *
 * IMPORTANT: T must be JSON-serializable (no functions/promises). Use AssertSerializable<T>
 * to verify your bucket type at compile time.
 *
 * @typeParam T - Bucket data type (must be JSON-serializable - no functions/promises)
 * @typeParam TKey - Entity identifier type
 */
export class RangeCache<T extends Bucket, TKey> {
  private readonly config: RangeCacheConfig<T, TKey>
  private readonly cache: ICache
  private readonly cacheWrapper: CacheWrapper

  constructor(config: RangeCacheConfig<T, TKey>, deps: RangeCacheDeps) {
    this.config = config
    this.cache = deps.cache
    this.cacheWrapper = new CacheWrapper({
      cache: deps.cache,
      defaultKeyTTLSeconds: DB_QUERY_TTL_SECONDS,
      defaultMaxAgeSeconds: DB_QUERY_TTL_SECONDS,
    })
  }

  /**
   * Get buckets for the given range, using cache when possible.
   *
   * @param key - Entity identifier
   * @param start - Range start (inclusive)
   * @param end - Range end (exclusive)
   * @returns Dense array of buckets, or empty array if no data
   */
  async getBuckets(key: TKey, start: Date, end: Date): Promise<T[]> {
    const { bucketWidthSeconds } = this.config

    // 1. Early exit for invalid range
    if (start >= end) {
      return []
    }

    // 2. Get earliest timestamp (internally cached)
    const earliestSeconds = await this.getEarliestTimestampCached(key)
    if (earliestSeconds === null) {
      // No data exists for this entity
      return []
    }

    // 3. Clamp end to now (handle client clock drift)
    const now = new Date()
    const clampedEnd = end > now ? now : end
    if (start >= clampedEnd) {
      return []
    }

    // 4. Determine current bucket boundary (open bucket)
    const currentBucketStart = getCurrentBucketStart(bucketWidthSeconds)

    // 5. Separate closed vs open bucket ranges
    const closedBucketsEnd = clampedEnd > currentBucketStart ? currentBucketStart : clampedEnd

    // 6. Align to bucket boundaries
    const startSeconds = Math.floor(start.getTime() / 1000)
    const closedEndSeconds = Math.floor(closedBucketsEnd.getTime() / 1000)
    const alignedStartSeconds = alignToBucketCeil(startSeconds, bucketWidthSeconds)
    const alignedEndSeconds = alignToBucketFloor(closedEndSeconds, bucketWidthSeconds)

    // 7. Clamp start to earliest data
    const effectiveStartSeconds = Math.max(alignedStartSeconds, alignToBucketCeil(earliestSeconds, bucketWidthSeconds))

    const zsetKey = this.config.cacheKey(key)
    let closedBuckets: T[] = []

    // 8. Query ZSET cache for closed buckets
    if (alignedEndSeconds > effectiveStartSeconds) {
      const cachedBuckets = await this.cache.zrange<T>(
        zsetKey,
        effectiveStartSeconds,
        alignedEndSeconds - bucketWidthSeconds, // last bucket starts 1 interval before end
        { order: "asc" },
      )

      // 9. Validate cache completeness
      const expected = expectedBucketCount(effectiveStartSeconds, alignedEndSeconds, bucketWidthSeconds)

      if (cachedBuckets.length === expected && expected > 0) {
        // Cache HIT - all closed buckets present
        closedBuckets = cachedBuckets
      } else {
        // Cache MISS or gaps - query DB and fill
        const effectiveStart = new Date(effectiveStartSeconds * 1000)
        const dbBuckets = await this.queryDbCached(key, effectiveStart, closedBucketsEnd)

        // Fill gaps to ensure dense data
        closedBuckets = await this.fillGapsInRange(key, dbBuckets, effectiveStartSeconds, alignedEndSeconds)

        // Populate ZSET with filled results
        if (closedBuckets.length > 0) {
          const members = closedBuckets.map((b) => ({
            score: b.unixTimestampSeconds,
            value: b as SuperJSONSerializable<T>,
          }))
          await this.cache.zadd(zsetKey, members)
        }
      }
    }

    // 10. Fetch open bucket from DB if requested range includes it
    if (clampedEnd > currentBucketStart) {
      const openBuckets = await this.queryDbCached(key, currentBucketStart, clampedEnd)
      return [...closedBuckets, ...openBuckets]
    }

    return closedBuckets
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /** Get earliest timestamp with caching and in-flight deduplication */
  private async getEarliestTimestampCached(key: TKey): Promise<number | null> {
    // Use config.cacheKey to ensure proper namespacing (e.g., "earliest:volume-hourly:0xabc")
    const cacheKey = `earliest:${this.config.cacheKey(key)}`

    const result = await this.cacheWrapper.wrapWithCache<number | null, unknown>({
      key: cacheKey,
      keyTTLSeconds: EARLIEST_TTL_SECONDS,
      maxAgeSeconds: EARLIEST_TTL_SECONDS,
      opName: `${this.config.opName}:earliestTimestamp`,
      fn: async () => Ok(await this.config.queryEarliestTimestamp(key)),
    })

    if (result.err) {
      throw result.val
    }
    return result.val as number | null
  }

  /** Query DB with caching and in-flight deduplication */
  private async queryDbCached(key: TKey, start: Date, end: Date): Promise<T[]> {
    const cacheKey = this.config.dbQueryCacheKey(key, start, end)

    const result = await this.cacheWrapper.wrapWithCache<T[], unknown>({
      key: cacheKey,
      opName: `${this.config.opName}:queryDb`,
      fn: async () => {
        const data = await this.config.queryBucketsFromDb(key, start, end)
        // Cast: T must be JSON-serializable per contract. Use AssertSerializable<T> to verify.
        return Ok(data as unknown as SuperJSONSerializable<T[]>)
      },
    })

    if (result.err) {
      throw result.val
    }
    return result.val as T[]
  }

  /**
   * Fill gaps in sparse bucket array to make it dense.
   * Uses getNearestBeforeOrEqualTo to seed the first bucket.
   */
  private async fillGapsInRange(key: TKey, sparseBuckets: T[], startSeconds: number, endSeconds: number): Promise<T[]> {
    const { bucketWidthSeconds, fillGap } = this.config

    if (endSeconds <= startSeconds) {
      return []
    }

    // Create lookup map for O(1) access
    const bucketMap = new Map<number, T>()
    for (const bucket of sparseBuckets) {
      bucketMap.set(bucket.unixTimestampSeconds, bucket)
    }

    // Get seed bucket (nearest before or at start)
    let previous = await this.config.getNearestBeforeOrEqualTo(key, startSeconds)

    // If no data exists before start, check if we have any buckets in range
    if (previous === null) {
      // Try to find the first bucket in our sparse data
      const sortedBuckets = [...sparseBuckets].sort((a, b) => a.unixTimestampSeconds - b.unixTimestampSeconds)
      if (sortedBuckets.length > 0) {
        previous = sortedBuckets[0]
      } else {
        // No data at all for this range
        return []
      }
    }

    const filledData: T[] = []

    // Iterate through all expected bucket timestamps
    for (let currentSeconds = startSeconds; currentSeconds < endSeconds; currentSeconds += bucketWidthSeconds) {
      const existing = bucketMap.get(currentSeconds)

      if (existing) {
        // Bucket exists in data
        filledData.push(existing)
        previous = existing
      } else {
        // Gap - generate filled bucket using callback
        const filled = fillGap(currentSeconds, previous)
        filledData.push(filled)
        previous = filled
      }
    }

    return filledData
  }
}
