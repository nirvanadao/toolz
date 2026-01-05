import { describe, it, expect, vi, beforeEach } from "vitest"
import { ICache, Option, None, Some, SuperJSONSerializable } from "@nirvana-tools/johnny-cache"
import {
  RangeCache,
  RangeCacheConfig,
  Bucket,
  AssertSerializable,
  alignToBucketFloor,
  alignToBucketCeil,
  expectedBucketCount,
} from "./index"

// ============================================================================
// Compile-time type tests for AssertSerializable
// ============================================================================

// Good bucket - should compile (AssertSerializable resolves to the type itself)
interface GoodBucket extends Bucket {
  unixTimestampSeconds: number
  value: number
  label: string
}
type _GoodBucketCheck = AssertSerializable<GoodBucket> // Should be GoodBucket

// Bad bucket with function - AssertSerializable resolves to `never`
interface BadBucketWithFunction extends Bucket {
  unixTimestampSeconds: number
  callback: () => void
}
type _BadBucketCheck = AssertSerializable<BadBucketWithFunction> // Should be `never`

// Compile-time assertion: if you uncomment this, it should fail to compile
// because BadBucketWithFunction is not serializable
// const _failingAssignment: _BadBucketCheck = { unixTimestampSeconds: 0, callback: () => {} }

describe("AssertSerializable type helper", () => {
  it("resolves to the type itself for serializable buckets", () => {
    // This is a compile-time check - if it compiles, it works
    const goodBucket: _GoodBucketCheck = { unixTimestampSeconds: 0, value: 100, label: "test" }
    expect(goodBucket.value).toBe(100)
  })

  it("resolves to never for non-serializable buckets (with functions)", () => {
    // _BadBucketCheck is `never`, so you can't assign anything to it
    // This test just verifies the type exists and the pattern works
    type IsNever<T> = [T] extends [never] ? true : false
    const badBucketIsNever: IsNever<_BadBucketCheck> = true
    expect(badBucketIsNever).toBe(true)
  })
})

// ============================================================================
// Mock Cache Implementation
// ============================================================================

class MockCache implements ICache {
  private store = new Map<string, unknown>()
  private zsets = new Map<string, Array<{ score: number; value: unknown }>>()

  async get<T>(key: string): Promise<Option<T>> {
    const value = this.store.get(key)
    if (value === undefined) {
      return None
    }
    return Some(value as T)
  }

  async set<T>(key: string, value: SuperJSONSerializable<T>): Promise<void> {
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async zadd<T>(key: string, members: Array<{ score: number; value: SuperJSONSerializable<T> }>): Promise<number> {
    let zset = this.zsets.get(key)
    if (!zset) {
      zset = []
      this.zsets.set(key, zset)
    }

    let added = 0
    for (const member of members) {
      const existingIdx = zset.findIndex((m) => m.score === member.score)
      if (existingIdx >= 0) {
        zset[existingIdx] = member
      } else {
        zset.push(member)
        added++
      }
    }

    // Keep sorted by score
    zset.sort((a, b) => a.score - b.score)
    return added
  }

  async zrange<T>(
    key: string,
    min: number,
    max: number,
    opts?: { order?: "asc" | "desc"; limit?: number },
  ): Promise<T[]> {
    const zset = this.zsets.get(key)
    if (!zset) {
      return []
    }

    let results = zset.filter((m) => m.score >= min && m.score <= max).map((m) => m.value as T)

    if (opts?.order === "desc") {
      results = results.reverse()
    }

    if (opts?.limit !== undefined) {
      results = results.slice(0, opts.limit)
    }

    return results
  }

  async zremRangeByScore(key: string, min: number, max: number): Promise<number> {
    const zset = this.zsets.get(key)
    if (!zset) {
      return 0
    }

    const before = zset.length
    const filtered = zset.filter((m) => m.score < min || m.score > max)
    this.zsets.set(key, filtered)
    return before - filtered.length
  }

  // Test helpers
  clear(): void {
    this.store.clear()
    this.zsets.clear()
  }

  getZset(key: string): Array<{ score: number; value: unknown }> | undefined {
    return this.zsets.get(key)
  }
}

// ============================================================================
// Test Data Types
// ============================================================================

interface TestBucket extends Bucket {
  unixTimestampSeconds: number
  value: number
}

const HOUR_SECONDS = 3600

// Base timestamp: 2024-01-01T00:00:00Z
const BASE_TS = 1704067200
const hour = (n: number) => BASE_TS + n * HOUR_SECONDS

// ============================================================================
// Utility Tests
// ============================================================================

describe("utility functions", () => {
  describe("alignToBucketFloor", () => {
    it("should align timestamp down to bucket boundary", () => {
      expect(alignToBucketFloor(3700, HOUR_SECONDS)).toBe(3600)
      expect(alignToBucketFloor(7199, HOUR_SECONDS)).toBe(3600)
      expect(alignToBucketFloor(7200, HOUR_SECONDS)).toBe(7200)
    })

    it("should return same value if already aligned", () => {
      expect(alignToBucketFloor(3600, HOUR_SECONDS)).toBe(3600)
      expect(alignToBucketFloor(0, HOUR_SECONDS)).toBe(0)
    })
  })

  describe("alignToBucketCeil", () => {
    it("should align timestamp up to bucket boundary", () => {
      expect(alignToBucketCeil(3601, HOUR_SECONDS)).toBe(7200)
      expect(alignToBucketCeil(1, HOUR_SECONDS)).toBe(3600)
    })

    it("should return same value if already aligned", () => {
      expect(alignToBucketCeil(3600, HOUR_SECONDS)).toBe(3600)
      expect(alignToBucketCeil(0, HOUR_SECONDS)).toBe(0)
    })
  })

  describe("expectedBucketCount", () => {
    it("should calculate expected bucket count", () => {
      expect(expectedBucketCount(0, 7200, HOUR_SECONDS)).toBe(2)
      expect(expectedBucketCount(0, 3600, HOUR_SECONDS)).toBe(1)
      expect(expectedBucketCount(3600, 7200, HOUR_SECONDS)).toBe(1)
    })

    it("should return 0 for invalid ranges", () => {
      expect(expectedBucketCount(7200, 3600, HOUR_SECONDS)).toBe(0)
      expect(expectedBucketCount(3600, 3600, HOUR_SECONDS)).toBe(0)
    })
  })
})

// ============================================================================
// RangeCache Tests
// ============================================================================

describe("RangeCache", () => {
  let mockCache: MockCache
  let dbData: TestBucket[]
  let earliestTimestamp: number | null
  let nearestBeforeData: TestBucket | null

  const createConfig = (): RangeCacheConfig<TestBucket, string> => ({
    opName: "test",
    cacheKey: (key) => `test:${key}`,
    bucketWidthSeconds: HOUR_SECONDS,
    queryEarliestTimestamp: vi.fn(async () => earliestTimestamp),
    getNearestBeforeOrEqualTo: vi.fn(async (_key, ts) => {
      if (nearestBeforeData) return nearestBeforeData
      // Find nearest bucket <= ts
      const sorted = [...dbData].sort((a, b) => b.unixTimestampSeconds - a.unixTimestampSeconds)
      return sorted.find((b) => b.unixTimestampSeconds <= ts) ?? null
    }),
    queryBucketsFromDb: vi.fn(async () => dbData),
    fillGap: (ts, prev) => ({ unixTimestampSeconds: ts, value: prev.value }),
    dbQueryCacheKey: (key, start, end) => `db:${key}:${start.toISOString()}-${end.toISOString()}`,
  })

  beforeEach(() => {
    mockCache = new MockCache()
    dbData = []
    earliestTimestamp = null
    nearestBeforeData = null
    vi.useFakeTimers()
    // Set current time to 2024-01-01 12:30:00 UTC
    vi.setSystemTime(new Date("2024-01-01T12:30:00Z"))
  })

  describe("empty data", () => {
    it("should return empty array when no data exists", async () => {
      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T12:00:00Z"),
      )

      expect(result).toEqual([])
    })

    it("should return empty array for invalid range (start >= end)", async () => {
      earliestTimestamp = 0
      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T12:00:00Z"),
        new Date("2024-01-01T06:00:00Z"),
      )

      expect(result).toEqual([])
    })
  })

  describe("cache miss - fetch from DB and fill gaps", () => {
    it("should fetch from DB and fill gaps on cache miss", async () => {
      // Data exists from hour 0
      earliestTimestamp = hour(0)

      // DB has sparse data - only hours 0 and 2
      dbData = [
        { unixTimestampSeconds: hour(0), value: 100 },
        { unixTimestampSeconds: hour(2), value: 300 },
      ]

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      // Query hours 0-3 (exclusive), but current bucket starts at hour 12
      // So we're querying closed buckets from hour 0 to hour 3
      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T03:00:00Z"),
      )

      // Should have 3 buckets: 0, 1 (filled), 2
      expect(result.length).toBe(3)
      expect(result[0]).toEqual({ unixTimestampSeconds: hour(0), value: 100 })
      expect(result[1]).toEqual({ unixTimestampSeconds: hour(1), value: 100 }) // filled from previous
      expect(result[2]).toEqual({ unixTimestampSeconds: hour(2), value: 300 })

      // Cache should be populated
      const cached = mockCache.getZset("test:test-key")
      expect(cached?.length).toBe(3)
    })
  })

  describe("cache hit", () => {
    it("should use cached data on cache hit", async () => {
      earliestTimestamp = hour(0)

      // Pre-populate cache
      await mockCache.zadd("test:test-key", [
        { score: hour(0), value: { unixTimestampSeconds: hour(0), value: 100 } },
        { score: hour(1), value: { unixTimestampSeconds: hour(1), value: 200 } },
        { score: hour(2), value: { unixTimestampSeconds: hour(2), value: 300 } },
      ])

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T03:00:00Z"),
      )

      expect(result.length).toBe(3)
      // Should not have called queryBucketsFromDb
      expect(config.queryBucketsFromDb).not.toHaveBeenCalled()
    })

    it("should fall back to DB if cache has gaps", async () => {
      earliestTimestamp = hour(0)

      // Pre-populate cache with gap (missing hour 1)
      await mockCache.zadd("test:test-key", [
        { score: hour(0), value: { unixTimestampSeconds: hour(0), value: 100 } },
        { score: hour(2), value: { unixTimestampSeconds: hour(2), value: 300 } },
      ])

      // DB will return full data
      dbData = [
        { unixTimestampSeconds: hour(0), value: 100 },
        { unixTimestampSeconds: hour(1), value: 200 },
        { unixTimestampSeconds: hour(2), value: 300 },
      ]

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T03:00:00Z"),
      )

      expect(result.length).toBe(3)
      expect(config.queryBucketsFromDb).toHaveBeenCalled()
    })
  })

  describe("open bucket handling", () => {
    it("should fetch open bucket from DB when query includes current time", async () => {
      earliestTimestamp = hour(0)

      // Current time is 12:30, so current bucket starts at 12:00
      // Query from 11:00 to 13:00 should include open bucket

      // Pre-populate cache for closed bucket (hour 11)
      await mockCache.zadd("test:test-key", [
        { score: hour(11), value: { unixTimestampSeconds: hour(11), value: 1100 } },
      ])

      // DB will return open bucket data
      dbData = [{ unixTimestampSeconds: hour(12), value: 1200 }] // 12:00 (open bucket)

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T11:00:00Z"),
        new Date("2024-01-01T13:00:00Z"),
      )

      // Should have closed bucket (11:00) + open bucket (12:00)
      expect(result.length).toBe(2)
      expect(result[0].unixTimestampSeconds).toBe(hour(11)) // 11:00 from cache
      expect(result[1].unixTimestampSeconds).toBe(hour(12)) // 12:00 from DB
    })
  })

  describe("earliest timestamp caching", () => {
    it("should cache earliest timestamp", async () => {
      earliestTimestamp = hour(0)
      dbData = [{ unixTimestampSeconds: hour(0), value: 100 }]

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      // First call
      await rangeCache.getBuckets("test-key", new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T01:00:00Z"))

      // Second call
      await rangeCache.getBuckets("test-key", new Date("2024-01-01T00:00:00Z"), new Date("2024-01-01T01:00:00Z"))

      // queryEarliestTimestamp should only be called once
      expect(config.queryEarliestTimestamp).toHaveBeenCalledTimes(1)
    })
  })

  describe("boundary clamping", () => {
    it("should clamp end to now if in the future", async () => {
      earliestTimestamp = hour(0)
      dbData = [{ unixTimestampSeconds: hour(0), value: 100 }]

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      // Query with end in future
      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-02T00:00:00Z"), // Tomorrow
      )

      // Should only have buckets up to current time (12:30)
      // Closed buckets: 0-11, Open bucket would be 12:00+
      expect(result.length).toBeGreaterThan(0)
      const lastBucket = result[result.length - 1]
      expect(lastBucket.unixTimestampSeconds).toBeLessThanOrEqual(hour(12))
    })

    it("should clamp start to earliest data", async () => {
      // Data starts at hour 5
      earliestTimestamp = hour(5)

      dbData = [{ unixTimestampSeconds: hour(5), value: 500 }]

      const config = createConfig()
      const rangeCache = new RangeCache(config, { cache: mockCache })

      // Query from hour 0, but data starts at hour 5
      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T06:00:00Z"),
      )

      // Should only have bucket at hour 5
      expect(result.length).toBe(1)
      expect(result[0].unixTimestampSeconds).toBe(hour(5))
    })
  })

  describe("zero-fill vs carry-forward", () => {
    it("should use provided fillGap for zero-fill pattern", async () => {
      earliestTimestamp = hour(0)
      dbData = [
        { unixTimestampSeconds: hour(0), value: 100 },
        { unixTimestampSeconds: hour(2), value: 300 },
      ]

      // Zero-fill: ignore previous, return 0
      const config: RangeCacheConfig<TestBucket, string> = {
        ...createConfig(),
        fillGap: (ts, _prev) => ({ unixTimestampSeconds: ts, value: 0 }),
      }

      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T03:00:00Z"),
      )

      expect(result[1]).toEqual({ unixTimestampSeconds: hour(1), value: 0 })
    })

    it("should use provided fillGap for carry-forward pattern", async () => {
      earliestTimestamp = hour(0)
      dbData = [
        { unixTimestampSeconds: hour(0), value: 100 },
        { unixTimestampSeconds: hour(2), value: 300 },
      ]

      // Carry-forward: use previous value
      const config: RangeCacheConfig<TestBucket, string> = {
        ...createConfig(),
        fillGap: (ts, prev) => ({ unixTimestampSeconds: ts, value: prev.value }),
      }

      const rangeCache = new RangeCache(config, { cache: mockCache })

      const result = await rangeCache.getBuckets(
        "test-key",
        new Date("2024-01-01T00:00:00Z"),
        new Date("2024-01-01T03:00:00Z"),
      )

      expect(result[1]).toEqual({ unixTimestampSeconds: hour(1), value: 100 })
    })
  })
})
