import { describe, it, expect, vi, beforeEach } from "vitest"
import { ICache } from "./types"
import { fillGapsInRange, expectedBucketCount, getBucketsInRange } from "./getRangeCached"

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
  })

  it("fills gap in middle", () => {
    // Missing 11:00
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
    expect(result.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
    // Original values preserved
    expect(result[0].value).toBe(1)
    expect(result[1].value).toBe(0) // filled
    expect(result[2].value).toBe(2)
  })

  it("fills gaps at end", () => {
    // Have 10:00 and 11:00, want up to 13:00
    const seedBucket = makeBucket(h(10), 1)
    const sparseBuckets = [makeBucket(h(10), 1), makeBucket(h(11), 2)]

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
    expect(result[0].value).toBe(1)
    expect(result[1].value).toBe(2)
    expect(result[2].value).toBe(0) // filled
    expect(result[3].value).toBe(0) // filled
  })

  it("fills gaps at beginning using seed bucket before desired range", () => {
    // Seed bucket at 09:00, desired range is 10:00-13:00
    // Sparse data only has 12:00 and 13:00
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
    // 10:00 and 11:00 are filled (carrying forward from 09:00 seed)
    expect(result[0].value).toBe(0) // filled
    expect(result[1].value).toBe(0) // filled
    expect(result[2].value).toBe(1)
    expect(result[3].value).toBe(2)
  })

  it("fills multiple gaps", () => {
    // Only have 10:00 and 14:00
    const seedBucket = makeBucket(h(10), 1)
    const sparseBuckets = [makeBucket(h(10), 1), makeBucket(h(14), 2)]

    const result = fillGapsInRange({
      pluckBucketTimestamp: pluckTs,
      desiredOldestBucketStart: h(10),
      desiredNewestBucketStart: h(14),
      bucketWidthMills: HOUR_MS,
      gapFillConstructor,
      seedBucket,
      sparseBuckets,
    })

    expect(result.length).toBe(5)
    expect(result.map(b => b.ts.getTime())).toEqual([
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
    const seedBucket = makeBucket(h(10), 1)
    const sparseBuckets = [makeBucket(h(10), 1)]

    const result = fillGapsInRange({
      pluckBucketTimestamp: pluckTs,
      desiredOldestBucketStart: h(10),
      desiredNewestBucketStart: h(10),
      bucketWidthMills: HOUR_MS,
      gapFillConstructor,
      seedBucket,
      sparseBuckets,
    })

    expect(result.length).toBe(1)
    expect(result[0].ts.getTime()).toBe(h(10).getTime())
    expect(result[0].value).toBe(1)
  })

  it("throws when seedBucket is after desired oldest", () => {
    const seedBucket = makeBucket(h(12), 1)
    const sparseBuckets = [makeBucket(h(12), 1)]

    expect(() =>
      fillGapsInRange({
        pluckBucketTimestamp: pluckTs,
        desiredOldestBucketStart: h(10),
        desiredNewestBucketStart: h(12),
        bucketWidthMills: HOUR_MS,
        gapFillConstructor,
        seedBucket,
        sparseBuckets,
      }),
    ).toThrow("seedBucket start time must be less than or equal to desired oldest bucket start")
  })

  it("throws when oldest is after newest", () => {
    const seedBucket = makeBucket(h(10), 1)

    expect(() =>
      fillGapsInRange({
        pluckBucketTimestamp: pluckTs,
        desiredOldestBucketStart: h(14),
        desiredNewestBucketStart: h(10),
        bucketWidthMills: HOUR_MS,
        gapFillConstructor,
        seedBucket,
        sparseBuckets: [],
      }),
    ).toThrow("desiredOldestBucketStart must be before desiredNewestBucketStart")
  })

  it("throws when oldest is not aligned to bucket width", () => {
    const seedBucket = makeBucket(h(10), 1)

    expect(() =>
      fillGapsInRange({
        pluckBucketTimestamp: pluckTs,
        desiredOldestBucketStart: h(10, 30),
        desiredNewestBucketStart: h(12),
        bucketWidthMills: HOUR_MS,
        gapFillConstructor,
        seedBucket,
        sparseBuckets: [],
      }),
    ).toThrow("oldestStart must be modulo 0 bucketWidthMills")
  })

  it("throws when newest is not aligned to bucket width", () => {
    const seedBucket = makeBucket(h(10), 1)

    expect(() =>
      fillGapsInRange({
        pluckBucketTimestamp: pluckTs,
        desiredOldestBucketStart: h(10),
        desiredNewestBucketStart: h(12, 30),
        bucketWidthMills: HOUR_MS,
        gapFillConstructor,
        seedBucket,
        sparseBuckets: [],
      }),
    ).toThrow("newestStart must be modulo 0 bucketWidthMills")
  })
})

describe("expectedBucketCount", () => {
  it("returns 1 for same start and end", () => {
    expect(
      expectedBucketCount({
        oldestBucketStart: h(12),
        newestBucketStart: h(12),
        bucketWidthMillis: HOUR_MS,
      }),
    ).toBe(1)
  })

  it("returns 2 for 1 hour apart", () => {
    // 12:00 and 13:00 -> 2 buckets
    expect(
      expectedBucketCount({
        oldestBucketStart: h(12),
        newestBucketStart: h(13),
        bucketWidthMillis: HOUR_MS,
      }),
    ).toBe(2)
  })

  it("returns 4 for 3 hours apart", () => {
    // 10:00, 11:00, 12:00, 13:00 -> 4 buckets
    expect(
      expectedBucketCount({
        oldestBucketStart: h(10),
        newestBucketStart: h(13),
        bucketWidthMillis: HOUR_MS,
      }),
    ).toBe(4)
  })

  it("returns 0 when start after end", () => {
    expect(
      expectedBucketCount({
        oldestBucketStart: h(14),
        newestBucketStart: h(12),
        bucketWidthMillis: HOUR_MS,
      }),
    ).toBe(0)
  })
})

describe("getBucketsInRange", () => {
  let mockCache: ICache

  beforeEach(() => {
    mockCache = {
      zadd: vi.fn().mockResolvedValue(0),
      zrange: vi.fn().mockResolvedValue([]),
      zremRangeByScore: vi.fn().mockResolvedValue(0),
    }
  })

  it("returns no-data when getEarliestBucketStart returns null", async () => {
    const result = await getBucketsInRange<string, TestBucket>({
      start: h(10),
      end: h(12),
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(null),
      getLatestBucketBefore: vi.fn().mockResolvedValue(null),
      getBucketsInRange: vi.fn(),
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14),
    })

    expect(result.err).toBe(true)
    if (result.err) {
      expect(result.val.type).toBe("no-data")
    }
  })

  it("returns cached data when cache is complete", async () => {
    // end=h(12) floors to h(12), giving lastClosedBucketStart=h(11)
    // So range is h(10) to h(11), expecting 2 buckets
    const cachedBuckets = [makeBucket(h(10)), makeBucket(h(11))]
    mockCache.zrange = vi.fn().mockResolvedValue(cachedBuckets)

    const dbQuery = vi.fn()

    const result = await getBucketsInRange<string, TestBucket>({
      start: h(10),
      end: h(12), // floor(h(12)) = h(12), so lastClosedBucketStart = h(11)
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getLatestBucketBefore: vi.fn().mockResolvedValue(null),
      getBucketsInRange: dbQuery,
      gapFillConstructor,
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
    // end=h(13) floors to h(13), so lastClosedBucketStart=h(12), range is 10:00-12:00 (3 buckets)
    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(10), 1), makeBucket(h(12), 2)])

    const result = await getBucketsInRange<string, TestBucket>({
      start: h(10),
      end: h(13), // floor(h(13)) = h(13), so lastClosedBucketStart = h(12)
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)),
      getLatestBucketBefore: vi.fn().mockResolvedValue(null),
      getBucketsInRange: dbQuery,
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14), // past, so all closed
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Should be 3 buckets: 10:00, 11:00 (filled), 12:00
      expect(result.val.length).toBe(3)
      expect(result.val.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
    }
  })

  it("trims range when earliest bucket is after requested start", async () => {
    // Request from 8:00, but data only starts at 10:00
    // end=h(12) floors to h(12), so lastClosedBucketStart=h(11), range is 10:00-11:00 (2 buckets)
    mockCache.zrange = vi.fn().mockResolvedValue([])

    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(10)), makeBucket(h(11))])

    const result = await getBucketsInRange<string, TestBucket>({
      start: h(8), // Request from 8:00
      end: h(12), // floor(h(12)) = h(12), so lastClosedBucketStart = h(11)
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(10)), // Data starts at 10:00
      getLatestBucketBefore: vi.fn().mockResolvedValue(null),
      getBucketsInRange: dbQuery,
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Only returns data from 10:00, not 8:00 or 9:00
      expect(result.val.length).toBe(2)
      expect(result.val[0].ts.getTime()).toBe(h(10).getTime())
    }

    // DB should be called with effective start of 10:00 and exclusive end of h(12)
    expect(dbQuery).toHaveBeenCalledWith(h(10), h(12))
  })

  it("returns no-data-in-range when earliest bucket is after requested end", async () => {
    // Request 8:00-9:00, but data only starts at 15:00
    mockCache.zrange = vi.fn().mockResolvedValue([])

    const result = await getBucketsInRange<string, TestBucket>({
      start: h(8),
      end: h(9),
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(15)), // Data starts at 15:00
      getLatestBucketBefore: vi.fn().mockResolvedValue(null),
      getBucketsInRange: vi.fn(),
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(20),
    })

    expect(result.err).toBe(true)
    if (result.err) {
      expect(result.val.type).toBe("no-data-in-range")
    }
  })

  it("uses seed bucket to fill gaps at the beginning of requested range", async () => {
    // Request 10:00-12:00, DB has data starting at 12:00
    // But there's a seed bucket at 9:00 to carry data forward
    // end=h(13) floors to h(13), so lastClosedBucketStart=h(12), range is 10:00-12:00 (3 buckets)
    mockCache.zrange = vi.fn().mockResolvedValue([])

    const dbQuery = vi.fn().mockResolvedValue([makeBucket(h(12), 3)])

    const result = await getBucketsInRange<string, TestBucket>({
      start: h(10),
      end: h(13), // floor(h(13)) = h(13), so lastClosedBucketStart = h(12)
      bucketWidthMills: HOUR_MS,
      cacheKeyNamespace: "test",
      entityKey: "entity1",
      getEarliestBucketStart: vi.fn().mockResolvedValue(h(9)), // earliest is at 9:00
      getLatestBucketBefore: vi.fn().mockResolvedValue(makeBucket(h(9), 5)), // seed bucket
      getBucketsInRange: dbQuery,
      gapFillConstructor,
      pluckBucketTimestamp: pluckTs,
      cache: mockCache,
      now: h(14),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      // Should have 3 buckets: 10:00 (filled), 11:00 (filled), 12:00
      expect(result.val.length).toBe(3)
      expect(result.val.map(b => b.ts.getTime())).toEqual([h(10).getTime(), h(11).getTime(), h(12).getTime()])
      expect(result.val[0].value).toBe(0) // filled from seed
      expect(result.val[1].value).toBe(0) // filled
      expect(result.val[2].value).toBe(3) // from DB
    }
  })
})
