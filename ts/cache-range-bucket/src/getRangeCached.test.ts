import { describe, it, expect, vi, beforeEach } from "vitest"
import { ICache } from "./types"
import { getTrueStartEnd, fillGapsInRange, expectedBucketCount, getBucketsInRange } from "./getRangeCached"
import { None, Some } from "ts-results"

// Helper to create dates at specific hours on a fixed day
const h = (hour: number, minute = 0) => new Date(Date.UTC(2024, 0, 1, hour, minute, 0, 0))

// Simple bucket type for testing
type TestBucket = { ts: number; value: number }
const makeBucket = (ts: number, value = 0): TestBucket => ({ ts, value })
const pluckTs = (b: TestBucket) => b.ts

describe("getTrueStartEnd", () => {
  it("returns all closed when end is in past hour", () => {
    // start=10:00, end=11:30, now=14:00
    // All data is historical, no open bucket needed
    const result = getTrueStartEnd(h(10), h(11, 30), h(14))

    expect(result.needsOpenBucket).toBe(false)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    // end=11:30 ceiled to 12:00
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(12).getTime())
  })

  it("needs open bucket when end is in current hour", () => {
    // start=10:00, end=12:30, now=12:45
    // We're asking for data up to 12:30, and now is 12:45 (same hour)
    const result = getTrueStartEnd(h(10), h(12, 30), h(12, 45))

    expect(result.needsOpenBucket).toBe(true)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    // endOfLastClosedBucket is truncated to 12:00 (the open bucket starts at 12:00)
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(12).getTime())
  })

  it("clamps end to now when end is in future", () => {
    // start=10:00, end=15:00, now=12:30
    // Asking for future data, clamp to now
    const result = getTrueStartEnd(h(10), h(15), h(12, 30))

    expect(result.needsOpenBucket).toBe(true)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    // Clamped to now=12:30, truncated to 12:00
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(12).getTime())
  })

  it("handles end exactly on hour boundary (closed)", () => {
    // start=10:00, end=12:00, now=14:00
    // end is exactly on hour, all closed
    const result = getTrueStartEnd(h(10), h(12), h(14))

    expect(result.needsOpenBucket).toBe(false)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    // 12:00 ceiled is still 12:00
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(12).getTime())
  })

  it("handles now exactly on hour boundary", () => {
    // start=10:00, end=12:30, now=12:00
    // now is exactly 12:00, end clamped to 12:00, which is on hour boundary
    // The 12:00 bucket just started with no data, so we don't need it
    const result = getTrueStartEnd(h(10), h(12, 30), h(12))

    expect(result.needsOpenBucket).toBe(false)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(12).getTime())
  })

  it("handles single hour range", () => {
    // start=10:00, end=10:30, now=14:00
    // Range within a single hour
    const result = getTrueStartEnd(h(10), h(10, 30), h(14))

    expect(result.needsOpenBucket).toBe(false)
    expect(result.startOfFirstBucket.getTime()).toBe(h(10).getTime())
    // 10:30 ceiled to 11:00
    expect(result.endOfLastClosedBucket.getTime()).toBe(h(11).getTime())
  })

  it("throws when start >= end", () => {
    expect(() => getTrueStartEnd(h(12), h(10), h(14))).toThrow("start must be before end")
    expect(() => getTrueStartEnd(h(12), h(12), h(14))).toThrow("start must be before end")
  })
})

describe("fillGapsInRange", () => {
  it("returns unchanged when no gaps", () => {
    const buckets = [makeBucket(h(10).getTime()), makeBucket(h(11).getTime()), makeBucket(h(12).getTime())]

    const result = fillGapsInRange(buckets, h(10), h(12), makeBucket, pluckTs)

    expect(result.length).toBe(3)
    expect(result.map(pluckTs)).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
  })

  it("fills gap in middle", () => {
    // Missing 11:00
    const buckets = [makeBucket(h(10).getTime(), 1), makeBucket(h(12).getTime(), 2)]

    const result = fillGapsInRange(buckets, h(10), h(12), makeBucket, pluckTs)

    expect(result.length).toBe(3)
    expect(result.map(pluckTs)).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
    // Original values preserved
    expect(result[0].value).toBe(1)
    expect(result[1].value).toBe(0) // filled
    expect(result[2].value).toBe(2)
  })

  it("fills gaps at end", () => {
    // Have 10:00 and 11:00, want up to 13:00
    const buckets = [makeBucket(h(10).getTime(), 1), makeBucket(h(11).getTime(), 2)]

    const result = fillGapsInRange(buckets, h(10), h(13), makeBucket, pluckTs)

    expect(result.length).toBe(4)
    expect(result.map(pluckTs)).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime(), h(13).getTime()])
    expect(result[0].value).toBe(1)
    expect(result[1].value).toBe(2)
    expect(result[2].value).toBe(0) // filled
    expect(result[3].value).toBe(0) // filled
  })

  it("fills gaps at beginning", () => {
    // Sparse data starts at 12:00, but we want from 10:00
    const buckets = [makeBucket(h(12).getTime(), 1), makeBucket(h(13).getTime(), 2)]

    const result = fillGapsInRange(buckets, h(10), h(13), makeBucket, pluckTs)

    expect(result.length).toBe(4)
    expect(result.map(pluckTs)).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime(), h(13).getTime()])
    expect(result[0].value).toBe(0) // filled
    expect(result[1].value).toBe(0) // filled
    expect(result[2].value).toBe(1)
    expect(result[3].value).toBe(2)
  })

  it("fills multiple gaps", () => {
    // Only have 10:00 and 14:00
    const buckets = [makeBucket(h(10).getTime(), 1), makeBucket(h(14).getTime(), 2)]

    const result = fillGapsInRange(buckets, h(10), h(14), makeBucket, pluckTs)

    expect(result.length).toBe(5)
    expect(result.map(pluckTs)).toEqual([
      h(10).getTime(),
      h(11).getTime(),
      h(12).getTime(),
      h(13).getTime(),
      h(14).getTime(),
    ])
    expect(result[0].value).toBe(1)
    expect(result[4].value).toBe(2)
    // Middle ones are filled
    expect(result[1].value).toBe(0)
    expect(result[2].value).toBe(0)
    expect(result[3].value).toBe(0)
  })

  it("handles single bucket", () => {
    const buckets = [makeBucket(h(10).getTime(), 1)]

    const result = fillGapsInRange(buckets, h(10), h(10), makeBucket, pluckTs)

    expect(result.length).toBe(1)
    expect(result[0].ts).toBe(h(10).getTime())
    expect(result[0].value).toBe(1)
  })

  it("returns empty for empty input", () => {
    const result = fillGapsInRange([], h(10), h(12), makeBucket, pluckTs)

    expect(result).toEqual([])
  })

  it("throws when oldest is after newest", () => {
    const buckets = [makeBucket(h(12).getTime())]

    expect(() => fillGapsInRange(buckets, h(14), h(10), makeBucket, pluckTs)).toThrow(
      "oldestStart must be before newestStart",
    )
  })

  it("throws when oldest is not hour-aligned", () => {
    const buckets = [makeBucket(h(10).getTime())]

    expect(() => fillGapsInRange(buckets, h(10, 30), h(12), makeBucket, pluckTs)).toThrow(
      "oldestStart must be modulo 0 a given number of seconds",
    )
  })

  it("throws when newest is not hour-aligned", () => {
    const buckets = [makeBucket(h(10).getTime())]

    expect(() => fillGapsInRange(buckets, h(10), h(12, 30), makeBucket, pluckTs)).toThrow(
      "newestStart must be modulo 0 a given number of seconds",
    )
  })
})

describe("expectedBucketCount", () => {
  it("returns 1 for same start and end", () => {
    expect(expectedBucketCount(h(12), h(12), 3600)).toBe(1)
  })

  it("returns 2 for 1 hour apart", () => {
    // 12:00 and 13:00 -> 2 buckets
    expect(expectedBucketCount(h(12), h(13), 3600)).toBe(2)
  })

  it("returns 4 for 3 hours apart", () => {
    // 10:00, 11:00, 12:00, 13:00 -> 4 buckets
    expect(expectedBucketCount(h(10), h(13), 3600)).toBe(4)
  })

  it("returns 0 when start after end", () => {
    expect(expectedBucketCount(h(14), h(12), 3600)).toBe(0)
  })
})

describe("getBucketsInRange", () => {
  let mockCache: ICache

  beforeEach(() => {
    mockCache = {
      get: vi.fn().mockResolvedValue(None),
      set: vi.fn().mockResolvedValue(undefined),
      zadd: vi.fn().mockResolvedValue(undefined),
      zrange: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      zremRangeByScore: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
    }
  })

  it("returns no-data when earliestBucketStart is null", async () => {
    const result = await getBucketsInRange({
      start: h(10),
      end: h(12),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(null),
      getHourlyBucketsInRange: vi.fn(),
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14),
    })

    expect(result.err).toBe(true)
    if (result.err) {
      expect(result.val.type).toBe("no-data")
    }
  })

  it("returns cached data when cache is complete and no open bucket needed", async () => {
    const cachedBuckets = [makeBucket(h(10).getTime()), makeBucket(h(11).getTime())]
    mockCache.zrange = vi.fn().mockResolvedValue(cachedBuckets)

    const dbQuery = vi.fn()

    const result = await getBucketsInRange({
      start: h(10),
      end: h(11, 30),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getHourlyBucketsInRange: dbQuery,
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14), // past, so no open bucket
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.val.length).toBe(2)
    }
    // DB should not be called
    expect(dbQuery).not.toHaveBeenCalled()
  })

  it("fetches from DB on cache miss and fills gaps", async () => {
    // Cache returns empty (miss)
    mockCache.zrange = vi.fn().mockResolvedValue([])

    // DB returns sparse data (missing 11:00)
    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(10).getTime(), 1), makeBucket(h(12).getTime(), 2)])

    const result = await getBucketsInRange({
      start: h(10),
      end: h(12, 30),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getHourlyBucketsInRange: dbQuery,
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14), // past, so all closed
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Should be 3 buckets: 10:00, 11:00 (filled), 12:00
      expect(result.val.length).toBe(3)
      expect(result.val.map(pluckTs)).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
    }
  })

  it("fetches open bucket when in current hour", async () => {
    // Cache returns the closed buckets
    const cachedBuckets = [makeBucket(h(10).getTime()), makeBucket(h(11).getTime())]
    mockCache.zrange = vi.fn().mockResolvedValue(cachedBuckets)

    // DB returns open bucket for current hour
    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(12).getTime(), 99)])

    const result = await getBucketsInRange({
      start: h(10),
      end: h(12, 30),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getHourlyBucketsInRange: dbQuery,
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(12, 45), // current hour is 12:00
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Should be 3 buckets: 10:00, 11:00 (from cache), 12:00 (open from DB)
      expect(result.val.length).toBe(3)
      expect(result.val[2].value).toBe(99) // open bucket
    }
  })

  it("trims range when earliestBucketStart is after requested start", async () => {
    // Request from 8:00, but data only starts at 10:00
    mockCache.zrange = vi.fn().mockResolvedValue([])

    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(10).getTime()), makeBucket(h(11).getTime())])

    const result = await getBucketsInRange({
      start: h(8), // Request from 8:00
      end: h(11, 30),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)), // Data starts at 10:00
      getHourlyBucketsInRange: dbQuery,
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Only returns data from 10:00, not 8:00 or 9:00
      expect(result.val.length).toBe(2)
      expect(result.val[0].ts).toBe(h(10).getTime())
    }

    // DB should be called with effective start of 10:00
    expect(dbQuery).toHaveBeenCalledWith("entity1", h(10), h(12))
  })

  it("creates default bucket when open bucket has no data", async () => {
    mockCache.zrange = vi.fn().mockResolvedValue([makeBucket(h(10).getTime())])

    // DB returns empty for open bucket query
    const dbQuery = vi.fn().mockResolvedValue([])

    const result = await getBucketsInRange({
      start: h(10),
      end: h(11, 30),
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getHourlyBucketsInRange: dbQuery,
      defaultConstructor: makeBucket,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(11, 30), // current hour is 11:00
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.val.length).toBe(2)
      // Second bucket should be a default-constructed one
      expect(result.val[1].ts).toBe(h(11).getTime())
      expect(result.val[1].value).toBe(0)
    }
  })
})
