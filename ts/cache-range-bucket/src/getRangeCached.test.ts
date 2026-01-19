import { describe, it, expect, beforeEach } from "vitest"
import { ICache } from "./types"
import { fillGapsInRange, expectedBucketCount, getBucketsInRange, GetBucketsInRangeParams } from "./getRangeCached"

// Helper to create dates at specific hours on a fixed day
const h = (hour: number, minute = 0) => new Date(Date.UTC(2024, 0, 1, hour, minute, 0, 0))

// One hour in milliseconds
const HOUR_MS = 3600 * 1000

// Simple bucket type for testing
type TestBucket = { ts: Date; value: number }
const makeBucket = (ts: Date, value = 0): TestBucket => ({ ts, value })
const pluckTs = (b: TestBucket) => b.ts
const gapFillConstructor = (prev: TestBucket): TestBucket => ({
  ts: new Date(prev.ts.getTime() + HOUR_MS),
  value: 0,
})

/**
 * In-memory mock cache that properly implements zset operations.
 * This allows us to test actual caching behavior.
 */
function createMockCache(): ICache & {
  _data: Map<string, Array<{ score: number; value: unknown }>>
  _getCalls: Array<{ key: string; start: number; end: number }>
  _replaceCalls: Array<{ key: string; start: number; end: number; members: Array<{ score: number; value: unknown }> }>
} {
  const data = new Map<string, Array<{ score: number; value: unknown }>>()
  const getCalls: Array<{ key: string; start: number; end: number }> = []
  const replaceCalls: Array<{ key: string; start: number; end: number; members: Array<{ score: number; value: unknown }> }> = []

  return {
    _data: data,
    _getCalls: getCalls,
    _replaceCalls: replaceCalls,

    async zrange<T>(
      key: string,
      start: number,
      end: number,
      _options?: { order: "asc" | "desc" },
    ): Promise<T[]> {
      getCalls.push({ key, start, end })
      const entries = data.get(key) || []
      // Filter by score range (inclusive on both ends for zrange)
      const filtered = entries
        .filter(e => e.score >= start && e.score <= end)
        .sort((a, b) => a.score - b.score)
      return filtered.map(e => e.value as T)
    },

    async zreplaceRange<T>(
      key: string,
      start: number,
      end: number,
      members: Array<{ score: number; value: T }>,
    ): Promise<number> {
      replaceCalls.push({ key, start, end, members: members as Array<{ score: number; value: unknown }> })

      // Remove existing entries in range (atomic with add)
      let entries = data.get(key) || []
      entries = entries.filter(e => e.score < start || e.score > end)

      // Add new members
      let added = 0
      for (const member of members) {
        const existingIdx = entries.findIndex(e => e.score === member.score)
        if (existingIdx >= 0) {
          entries[existingIdx] = member
        } else {
          entries.push(member)
          added++
        }
      }

      // Sort by score
      entries.sort((a, b) => a.score - b.score)
      data.set(key, entries)
      return added
    },
  }
}

/**
 * Creates a mock database that stores buckets and tracks calls
 */
function createMockDb() {
  const buckets: TestBucket[] = []
  const rangeCalls: Array<{ start: Date; end: Date }> = []
  const latestBeforeCalls: Date[] = []

  return {
    buckets,
    rangeCalls,
    latestBeforeCalls,

    addBucket(ts: Date, value: number) {
      buckets.push(makeBucket(ts, value))
      buckets.sort((a, b) => a.ts.getTime() - b.ts.getTime())
    },

    getEarliestBucketStart: async (): Promise<Date | null> => {
      if (buckets.length === 0) return null
      return buckets[0].ts
    },

    getBucketsInRange: async (start: Date, end: Date): Promise<TestBucket[]> => {
      rangeCalls.push({ start, end })
      return buckets.filter(b => b.ts.getTime() >= start.getTime() && b.ts.getTime() < end.getTime())
    },

    getLatestBucketBefore: async (ts: Date): Promise<TestBucket | null> => {
      latestBeforeCalls.push(ts)
      const before = buckets.filter(b => b.ts.getTime() < ts.getTime())
      if (before.length === 0) return null
      return before[before.length - 1]
    },
  }
}

// ============================================================================
// Unit Tests for fillGapsInRange
// ============================================================================

describe("fillGapsInRange", () => {
  it("returns unchanged when no gaps and seed is first bucket", () => {
    const seedBucket = makeBucket(h(10), 1)
    const sparseBuckets = [makeBucket(h(10), 1), makeBucket(h(11), 2), makeBucket(h(12), 3)]

    const result = fillGapsInRange({
      pluckBucketTimestamp: pluckTs,
      desiredOldestBucketStart: h(10),
      desiredNewestBucketStart: h(12),
      bucketWidthMills: HOUR_MS,
      gapFillConstructor,
      seedBucket,
      sparseBuckets,
    })

    expect(result.length).toBe(3)
    expect(result.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
    expect(result.map(b => b.value)).toEqual([1, 2, 3])
  })

  it("fills gap in middle", () => {
    const seedBucket = makeBucket(h(10), 1)
    const sparseBuckets = [makeBucket(h(10), 1), makeBucket(h(12), 2)]

    const result = fillGapsInRange({
      pluckBucketTimestamp: pluckTs,
      desiredOldestBucketStart: h(10),
      desiredNewestBucketStart: h(12),
      bucketWidthMills: HOUR_MS,
      gapFillConstructor,
      seedBucket,
      sparseBuckets,
    })

    expect(result.length).toBe(3)
    expect(result.map(b => b.value)).toEqual([1, 0, 2])
  })

  it("fills gaps at beginning using seed bucket before desired range", () => {
    const seedBucket = makeBucket(h(9), 5)
    const sparseBuckets = [makeBucket(h(12), 1), makeBucket(h(13), 2)]

    const result = fillGapsInRange({
      pluckBucketTimestamp: pluckTs,
      desiredOldestBucketStart: h(10),
      desiredNewestBucketStart: h(13),
      bucketWidthMills: HOUR_MS,
      gapFillConstructor,
      seedBucket,
      sparseBuckets,
    })

    expect(result.length).toBe(4)
    expect(result.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime(), h(13).getTime()])
    // Seed at 9:00 is filtered out, 10:00 and 11:00 are filled
    expect(result.map(b => b.value)).toEqual([0, 0, 1, 2])
  })

  it("throws when seedBucket is after desired oldest", () => {
    expect(() =>
      fillGapsInRange({
        pluckBucketTimestamp: pluckTs,
        desiredOldestBucketStart: h(10),
        desiredNewestBucketStart: h(12),
        bucketWidthMills: HOUR_MS,
        gapFillConstructor,
        seedBucket: makeBucket(h(12), 1),
        sparseBuckets: [],
      }),
    ).toThrow("seedBucket start time must be less than or equal to desired oldest bucket start")
  })
})

describe("expectedBucketCount", () => {
  it("returns correct counts", () => {
    expect(expectedBucketCount({ oldestBucketStart: h(12), newestBucketStart: h(12), bucketWidthMillis: HOUR_MS })).toBe(1)
    expect(expectedBucketCount({ oldestBucketStart: h(12), newestBucketStart: h(13), bucketWidthMillis: HOUR_MS })).toBe(2)
    expect(expectedBucketCount({ oldestBucketStart: h(10), newestBucketStart: h(13), bucketWidthMillis: HOUR_MS })).toBe(4)
    expect(expectedBucketCount({ oldestBucketStart: h(14), newestBucketStart: h(12), bucketWidthMillis: HOUR_MS })).toBe(0)
  })
})

// ============================================================================
// Integration Tests with Mock Cache
// ============================================================================

describe("getBucketsInRange with mock cache", () => {
  let cache: ReturnType<typeof createMockCache>
  let db: ReturnType<typeof createMockDb>

  beforeEach(() => {
    cache = createMockCache()
    db = createMockDb()
  })

  function makeParams(overrides: Partial<GetBucketsInRangeParams<string, TestBucket>> = {}): GetBucketsInRangeParams<string, TestBucket> {
    return {
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      start: h(10),
      end: h(13), // floors to h(13), lastClosedBucketStart = h(12)
      bucketWidthMills: HOUR_MS,
      getEarliestBucketStart: db.getEarliestBucketStart,
      getLatestBucketBefore: db.getLatestBucketBefore,
      getBucketsInRange: db.getBucketsInRange,
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache,
      now: h(20), // well in the past
      ...overrides,
    }
  }

  describe("cache miss scenarios", () => {
    it("fetches from DB and writes to cache on cache miss", async () => {
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(3)
        expect(result.val.map(b => b.value)).toEqual([100, 110, 120])
      }

      // Verify DB was called
      expect(db.rangeCalls.length).toBe(1)
      expect(db.rangeCalls[0].start.getTime()).toBe(h(10).getTime())

      // Wait for fire-and-forget cache write
      await new Promise(r => setTimeout(r, 10))

      // Verify cache was written
      expect(cache._replaceCalls.length).toBe(1)
      expect(cache._replaceCalls[0].members.length).toBe(3)
    })

    it("fills gaps when DB returns sparse data", async () => {
      // Only 10:00 and 12:00, missing 11:00
      db.addBucket(h(10), 100)
      db.addBucket(h(12), 120)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(3)
        expect(result.val.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
        expect(result.val.map(b => b.value)).toEqual([100, 0, 120]) // 11:00 is gap-filled
      }
    })

    it("uses seed bucket when first DB result is after range start", async () => {
      // Seed bucket at 9:00, range data starts at 11:00
      db.addBucket(h(9), 90) // seed
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(3)
        // 10:00 should be gap-filled using seed from 9:00
        expect(result.val.map(b => b.value)).toEqual([0, 110, 120])
      }

      // getLatestBucketBefore should have been called
      expect(db.latestBeforeCalls.length).toBe(1)
    })
  })

  describe("cache hit scenarios", () => {
    it("returns cached data without hitting DB when cache is complete", async () => {
      // Pre-populate cache
      await cache.zreplaceRange(
        "rangedLookup:ns-test:entity-entity1:bucketWidthMillis-3600000",
        h(10).getTime(),
        h(12).getTime(),
        [
          { score: h(10).getTime(), value: makeBucket(h(10), 100) },
          { score: h(11).getTime(), value: makeBucket(h(11), 110) },
          { score: h(12).getTime(), value: makeBucket(h(12), 120) },
        ],
      )

      // Also need DB to have data for earliest bucket check
      db.addBucket(h(10), 100)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(3)
        expect(result.val.map(b => b.value)).toEqual([100, 110, 120])
      }

      // DB range query should NOT have been called (cache hit)
      expect(db.rangeCalls.length).toBe(0)
    })

    it("fetches from DB when cache has wrong count", async () => {
      // Cache only has 2 buckets but we need 3
      await cache.zreplaceRange(
        "rangedLookup:ns-test:entity-entity1:bucketWidthMillis-3600000",
        h(10).getTime(),
        h(11).getTime(),
        [
          { score: h(10).getTime(), value: makeBucket(h(10), 100) },
          { score: h(11).getTime(), value: makeBucket(h(11), 110) },
          // Missing h(12)
        ],
      )

      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(3)
      }

      // DB should have been called because cache was incomplete
      expect(db.rangeCalls.length).toBe(1)
    })

    it("fetches from DB when cache has wrong start timestamp", async () => {
      // Cache has correct count but starts at wrong time
      await cache.zreplaceRange(
        "rangedLookup:ns-test:entity-entity1:bucketWidthMillis-3600000",
        h(11).getTime(),
        h(13).getTime(),
        [
          { score: h(11).getTime(), value: makeBucket(h(11), 110) },
          { score: h(12).getTime(), value: makeBucket(h(12), 120) },
          { score: h(13).getTime(), value: makeBucket(h(13), 130) },
        ],
      )

      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      const result = await getBucketsInRange(makeParams())

      expect(result.ok).toBe(true)

      // DB should have been called because cache start doesn't match
      expect(db.rangeCalls.length).toBe(1)
    })
  })

  describe("different entity keys", () => {
    it("uses separate cache entries for different entities", async () => {
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      // Query for entity1
      await getBucketsInRange(makeParams({ entityKey: "entity1" }))

      // Query for entity2
      await getBucketsInRange(makeParams({ entityKey: "entity2" }))

      // Both should hit DB since they're different entities
      expect(db.rangeCalls.length).toBe(2)

      // Wait for cache writes
      await new Promise(r => setTimeout(r, 10))

      // Both should write to different cache keys
      expect(cache._replaceCalls.length).toBe(2)
      expect(cache._replaceCalls[0].key).toContain("entity1")
      expect(cache._replaceCalls[1].key).toContain("entity2")
    })
  })

  describe("error scenarios", () => {
    it("returns no-data when DB has no buckets", async () => {
      // DB is empty

      const result = await getBucketsInRange(makeParams())

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("no-data")
      }
    })

    it("returns no-data-in-range when earliest bucket is after requested range", async () => {
      db.addBucket(h(20), 200) // Data starts at 20:00

      const result = await getBucketsInRange(makeParams({
        start: h(10),
        end: h(13),
      }))

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("no-data-in-range")
      }
    })

    it("returns error when seed bucket is needed but not found", async () => {
      // Data starts at 11:00, so we need seed bucket at 10:00, but it doesn't exist
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      // Override getEarliestBucketStart to say data starts at 10:00
      // but the actual range query won't find 10:00
      const result = await getBucketsInRange(makeParams({
        getEarliestBucketStart: async () => h(10),
      }))

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("db-get-latest-bucket-before-null-error")
      }
    })
  })

  describe("boundary conditions", () => {
    it("handles request for single bucket", async () => {
      db.addBucket(h(10), 100)

      const result = await getBucketsInRange(makeParams({
        start: h(10),
        end: h(11), // floors to h(11), lastClosedBucketStart = h(10), so single bucket
      }))

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(1)
        expect(result.val[0].value).toBe(100)
      }
    })

    it("handles now exactly on bucket boundary", async () => {
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)

      // now = h(12) exactly, end = h(13)
      // end clamped to h(12), floors to h(12), lastClosedBucketStart = h(11)
      const result = await getBucketsInRange(makeParams({
        start: h(10),
        end: h(13),
        now: h(12), // exactly on boundary
      }))

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(2) // 10:00 and 11:00
        expect(result.val.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime()])
      }
    })

    it("clamps end to now when end is in future", async () => {
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)

      const result = await getBucketsInRange(makeParams({
        start: h(10),
        end: h(20), // way in the future
        now: h(12), // but now is 12:00
      }))

      expect(result.ok).toBe(true)
      if (result.ok) {
        // end clamped to 12:00, floors to 12:00, lastClosedBucketStart = 11:00
        expect(result.val.length).toBe(2)
      }
    })

    it("handles multiple consecutive queries correctly", async () => {
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)

      // First query - cache miss
      const result1 = await getBucketsInRange(makeParams())
      expect(result1.ok).toBe(true)
      expect(db.rangeCalls.length).toBe(1)

      // Wait for cache write
      await new Promise(r => setTimeout(r, 10))

      // Second query - should be cache hit
      const result2 = await getBucketsInRange(makeParams())
      expect(result2.ok).toBe(true)
      expect(db.rangeCalls.length).toBe(1) // Still 1, no new DB call

      if (result1.ok && result2.ok) {
        expect(result1.val.map(b => b.value)).toEqual(result2.val.map(b => b.value))
      }
    })

    it("handles overlapping ranges correctly", async () => {
      db.addBucket(h(8), 80)
      db.addBucket(h(9), 90)
      db.addBucket(h(10), 100)
      db.addBucket(h(11), 110)
      db.addBucket(h(12), 120)
      db.addBucket(h(13), 130)

      // First query: 10:00-12:00
      const result1 = await getBucketsInRange(makeParams({
        start: h(10),
        end: h(13), // lastClosedBucketStart = h(12)
      }))
      expect(result1.ok).toBe(true)
      if (result1.ok) {
        expect(result1.val.length).toBe(3)
      }

      // Wait for cache write
      await new Promise(r => setTimeout(r, 10))

      // Second query: 8:00-10:00 (different range)
      const result2 = await getBucketsInRange(makeParams({
        start: h(8),
        end: h(11), // lastClosedBucketStart = h(10)
      }))
      expect(result2.ok).toBe(true)
      if (result2.ok) {
        expect(result2.val.length).toBe(3)
        expect(result2.val.map(b => b.value)).toEqual([80, 90, 100])
      }
    })
  })

  describe("15-minute bucket width", () => {
    const QUARTER_HOUR_MS = 15 * 60 * 1000

    it("works with 15-minute buckets", async () => {
      const q = (hour: number, minute: number) => new Date(Date.UTC(2024, 0, 1, hour, minute, 0, 0))

      // Create a custom DB for 15-min buckets
      const db15 = createMockDb()
      db15.addBucket(q(10, 0), 100)
      db15.addBucket(q(10, 15), 101)
      db15.addBucket(q(10, 30), 102)
      db15.addBucket(q(10, 45), 103)

      const gapFill15 = (prev: TestBucket): TestBucket => ({
        ts: new Date(prev.ts.getTime() + QUARTER_HOUR_MS),
        value: 0,
      })

      const result = await getBucketsInRange<string, TestBucket>({
        cacheKeyNamespace: "test15",
        entityKey: "entity1",
        start: q(10, 0),
        end: q(11, 0), // floors to 11:00, lastClosedBucketStart = 10:45
        bucketWidthMills: QUARTER_HOUR_MS,
        getEarliestBucketStart: db15.getEarliestBucketStart,
        getLatestBucketBefore: db15.getLatestBucketBefore,
        getBucketsInRange: db15.getBucketsInRange,
        gapFillConstructor: gapFill15,
        pluckBucketTimestamp: pluckTs,
        cache,
        now: q(12, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.length).toBe(4)
        expect(result.val.map(b => b.value)).toEqual([100, 101, 102, 103])
      }
    })
  })
})
