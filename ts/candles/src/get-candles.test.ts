import { describe, it, expect, vi, beforeEach, Mock } from "vitest"
import { None, Ok, Some, Err } from "ts-results"
import {
  getCandlesInRange,
  GetCandlesParams,
  gapFillConstructor,
  pluckCandleTimestamp,
  needsOpenCandle,
  NeedsOpenCandleParams,
  mapClosedCandlesResult,
  computeOpenCandle,
} from "./get-candles"
import { Candle, ICache } from "./types"
import { RangeResult, RangeCachedErrors } from "@nirvana-tools/cache-range-buckets"

// Mock the cache-range-buckets module
vi.mock("@nirvana-tools/cache-range-buckets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nirvana-tools/cache-range-buckets")>()
  return {
    ...actual,
    getBucketsInRange: vi.fn(),
  }
})

import { getBucketsInRange } from "@nirvana-tools/cache-range-buckets"

// ============================================================================
// Test Helpers
// ============================================================================

const HOUR_MILLIS = 60 * 60 * 1000
const MINUTE_MILLIS = 60 * 1000

const BASE_TS = new Date("2024-01-01T00:00:00Z").getTime()
const hour = (n: number) => BASE_TS + n * HOUR_MILLIS
const minute = (n: number) => BASE_TS + n * MINUTE_MILLIS
const hourDate = (n: number) => new Date(hour(n))
const minuteDate = (n: number) => new Date(minute(n))

function makeCandle(timestampMillis: number, ohlc: { o: number; h: number; l: number; c: number }): Candle {
  return {
    timestampMillis,
    data: {
      open: ohlc.o,
      high: ohlc.h,
      low: ohlc.l,
      close: ohlc.c,
    },
  }
}

function makeFlatCandle(timestampMillis: number, price: number): Candle {
  return makeCandle(timestampMillis, { o: price, h: price, l: price, c: price })
}

// ============================================================================
// gapFillConstructor Tests
// ============================================================================

describe("gapFillConstructor", () => {
  describe("timestamp advancement", () => {
    it("should advance timestamp by bucket width for 1-hour buckets", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeFlatCandle(hour(5), 100)
      const filled = fill(prev)
      expect(filled.timestampMillis).toBe(hour(6))
    })

    it("should advance timestamp by bucket width for 15-minute buckets", () => {
      const fill = gapFillConstructor(15 * MINUTE_MILLIS)
      const prev = makeFlatCandle(minute(30), 100)
      const filled = fill(prev)
      expect(filled.timestampMillis).toBe(minute(45))
    })

    it("should advance timestamp by bucket width for 5-minute buckets", () => {
      const fill = gapFillConstructor(5 * MINUTE_MILLIS)
      const prev = makeFlatCandle(minute(10), 100)
      const filled = fill(prev)
      expect(filled.timestampMillis).toBe(minute(15))
    })

    it("should advance timestamp by bucket width for 4-hour buckets", () => {
      const fill = gapFillConstructor(4 * HOUR_MILLIS)
      const prev = makeFlatCandle(hour(0), 100)
      const filled = fill(prev)
      expect(filled.timestampMillis).toBe(hour(4))
    })

    it("should advance timestamp by bucket width for 1-day buckets", () => {
      const fill = gapFillConstructor(24 * HOUR_MILLIS)
      const prev = makeFlatCandle(hour(0), 100)
      const filled = fill(prev)
      expect(filled.timestampMillis).toBe(hour(24))
    })
  })

  describe("price carry-forward", () => {
    it("should set all OHLC fields to previous close price", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeCandle(hour(5), { o: 90, h: 110, l: 85, c: 100 })
      const filled = fill(prev)

      expect(filled.data.open).toBe(100)
      expect(filled.data.high).toBe(100)
      expect(filled.data.low).toBe(100)
      expect(filled.data.close).toBe(100)
    })

    it("should handle zero price", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeFlatCandle(hour(5), 0)
      const filled = fill(prev)

      expect(filled.data.open).toBe(0)
      expect(filled.data.high).toBe(0)
      expect(filled.data.low).toBe(0)
      expect(filled.data.close).toBe(0)
    })

    it("should handle very small fractional prices", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeFlatCandle(hour(5), 0.00000001)
      const filled = fill(prev)

      expect(filled.data.close).toBe(0.00000001)
    })

    it("should handle very large prices", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeFlatCandle(hour(5), 999999999.99)
      const filled = fill(prev)

      expect(filled.data.close).toBe(999999999.99)
    })

    it("should handle negative prices (if applicable)", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const prev = makeFlatCandle(hour(5), -10)
      const filled = fill(prev)

      expect(filled.data.close).toBe(-10)
    })
  })

  describe("chaining", () => {
    it("should support chaining multiple gap fills", () => {
      const fill = gapFillConstructor(HOUR_MILLIS)
      const start = makeFlatCandle(hour(0), 100)

      const gap1 = fill(start)
      const gap2 = fill(gap1)
      const gap3 = fill(gap2)

      expect(gap1.timestampMillis).toBe(hour(1))
      expect(gap2.timestampMillis).toBe(hour(2))
      expect(gap3.timestampMillis).toBe(hour(3))

      // All should carry forward the same price
      expect(gap1.data.close).toBe(100)
      expect(gap2.data.close).toBe(100)
      expect(gap3.data.close).toBe(100)
    })
  })
})

// ============================================================================
// pluckCandleTimestamp Tests
// ============================================================================

describe("pluckCandleTimestamp", () => {
  it("should return Date from candle timestampMillis", () => {
    const candle = makeFlatCandle(hour(5), 100)
    const result = pluckCandleTimestamp(candle)
    expect(result).toEqual(hourDate(5))
  })

  it("should handle epoch timestamp", () => {
    const candle = makeFlatCandle(0, 100)
    const result = pluckCandleTimestamp(candle)
    expect(result).toEqual(new Date(0))
  })

  it("should handle sub-second precision", () => {
    const ts = hour(5) + 500 // 500ms into the hour
    const candle = makeFlatCandle(ts, 100)
    const result = pluckCandleTimestamp(candle)
    expect(result.getTime()).toBe(ts)
  })
})

// ============================================================================
// needsOpenCandle Tests
// ============================================================================

describe("needsOpenCandle", () => {
  // Using 1-hour buckets for these tests
  // If endOfLastClosedBucket = 12:00, then open bucket is 12:00-13:00

  describe("when now is within the open bucket", () => {
    it("should return true when query end extends past closed bucket", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T12:30:00Z"),           // 12:30 - in open bucket
        desiredSearchEnd: new Date("2024-01-01T13:00:00Z"), // query ends at 13:00
        endOfLastClosedBucket: new Date("2024-01-01T12:00:00Z"), // closed through 12:00
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })

    it("should return false when query end is at or before closed bucket end", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T12:30:00Z"),
        desiredSearchEnd: new Date("2024-01-01T12:00:00Z"), // query ends exactly at closed boundary
        endOfLastClosedBucket: new Date("2024-01-01T12:00:00Z"),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })

    it("should return false when query end is before closed bucket end", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T12:30:00Z"),
        desiredSearchEnd: new Date("2024-01-01T10:00:00Z"), // query ends well before
        endOfLastClosedBucket: new Date("2024-01-01T12:00:00Z"),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })
  })

  describe("when now is exactly at bucket boundary", () => {
    it("should return false when now equals endOfLastClosedBucket", () => {
      // now is exactly at the boundary - the bucket just closed
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T12:00:00Z"),
        desiredSearchEnd: new Date("2024-01-01T13:00:00Z"),
        endOfLastClosedBucket: new Date("2024-01-01T12:00:00Z"),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })
  })

  describe("when now is past the open bucket", () => {
    it("should return false when now is past the open bucket window", () => {
      // This shouldn't normally happen in practice, but test the boundary
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T13:30:00Z"),           // 13:30 - past the open bucket
        desiredSearchEnd: new Date("2024-01-01T14:00:00Z"),
        endOfLastClosedBucket: new Date("2024-01-01T12:00:00Z"), // stale - should be 13:00
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })
  })

  describe("edge cases at exact milliseconds", () => {
    it("should return true when now is 1ms into open bucket", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date(hour(12) + 1),                    // 12:00:00.001
        desiredSearchEnd: hourDate(13),
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })

    it("should return false when now is 1ms before bucket boundary", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date(hour(12) - 1),                    // 11:59:59.999
        desiredSearchEnd: hourDate(13),
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })

    it("should return true when now is 1ms before bucket end", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date(hour(13) - 1),                    // 12:59:59.999
        desiredSearchEnd: hourDate(14),
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })

    it("should return false when now is exactly at bucket end", () => {
      const params: NeedsOpenCandleParams = {
        now: hourDate(13),                              // exactly 13:00
        desiredSearchEnd: hourDate(14),
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(false)
    })
  })

  describe("with different bucket widths", () => {
    it("should work with 5-minute buckets", () => {
      const params: NeedsOpenCandleParams = {
        now: minuteDate(32),                            // 00:32 - in 30-35 bucket
        desiredSearchEnd: minuteDate(40),
        endOfLastClosedBucket: minuteDate(30),          // closed through 00:30
        bucketWidthMillis: 5 * MINUTE_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })

    it("should work with 15-minute buckets", () => {
      const params: NeedsOpenCandleParams = {
        now: minuteDate(47),                            // 00:47 - in 45-60 bucket
        desiredSearchEnd: minuteDate(60),
        endOfLastClosedBucket: minuteDate(45),
        bucketWidthMillis: 15 * MINUTE_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })

    it("should work with 4-hour buckets", () => {
      const params: NeedsOpenCandleParams = {
        now: hourDate(14),                              // 14:00 - in 12-16 bucket
        desiredSearchEnd: hourDate(16),
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: 4 * HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })
  })

  describe("query end boundary conditions", () => {
    it("should return true when desiredSearchEnd is 1ms past closed boundary", () => {
      const params: NeedsOpenCandleParams = {
        now: new Date("2024-01-01T12:30:00Z"),
        desiredSearchEnd: new Date(hour(12) + 1),       // 1ms past boundary
        endOfLastClosedBucket: hourDate(12),
        bucketWidthMillis: HOUR_MILLIS,
      }
      expect(needsOpenCandle(params)).toBe(true)
    })
  })
})

// ============================================================================
// mapClosedCandlesResult Tests
// ============================================================================

describe("mapClosedCandlesResult", () => {
  describe("error handling", () => {
    it("should wrap RangeCachedError in GetCandlesError", () => {
      const innerError = RangeCachedErrors.GetRangeFromDbError("DB failed", new Error("connection refused"))
      const input = Err(innerError)

      const result = mapClosedCandlesResult(input)

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("internal-range-cache-error")
        if (result.val.type === "internal-range-cache-error") {
          expect(result.val.inner).toBe(innerError)
        }
      }
    })

    it("should handle zrange errors", () => {
      const innerError = RangeCachedErrors.GetZrangeError("Cache error", new Error("timeout"))
      const input = Err(innerError)

      const result = mapClosedCandlesResult(input)

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("internal-range-cache-error")
      }
    })

    it("should handle missing seed bucket errors", () => {
      const innerError = RangeCachedErrors.MissingSeedBucketError("No seed found")
      const input = Err(innerError)

      const result = mapClosedCandlesResult(input)

      expect(result.err).toBe(true)
    })
  })

  describe("no-data-at-all result", () => {
    it("should map to empty history with no-data-at-all status", () => {
      const rangeResult: RangeResult<Candle> = { type: "no-data-at-all" }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.historyAscending).toEqual([])
        expect(result.val.status).toEqual({ type: "no-data-at-all" })
      }
    })
  })

  describe("search-range-ends-before-earliest result", () => {
    it("should map to empty history with range-before-earliest status", () => {
      const earliest = hourDate(10)
      const rangeResult: RangeResult<Candle> = {
        type: "search-range-ends-before-earliest",
        earliestDataInDb: earliest,
      }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.historyAscending).toEqual([])
        expect(result.val.status).toEqual({ type: "range-before-earliest", earliest })
      }
    })
  })

  describe("ok result", () => {
    it("should map buckets to historyAscending with ok status", () => {
      const candles = [
        makeFlatCandle(hour(0), 100),
        makeFlatCandle(hour(1), 110),
        makeFlatCandle(hour(2), 120),
      ]
      const rangeResult: RangeResult<Candle> = {
        type: "ok",
        effectiveSearchStart: hourDate(0),
        effectiveSearchEnd: hourDate(3),
        earliestDataInDb: hourDate(0),
        buckets: candles,
      }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.historyAscending).toEqual(candles)
        expect(result.val.status).toEqual({ type: "ok" })
      }
    })

    it("should handle empty buckets array", () => {
      const rangeResult: RangeResult<Candle> = {
        type: "ok",
        effectiveSearchStart: hourDate(0),
        effectiveSearchEnd: hourDate(0),
        earliestDataInDb: hourDate(0),
        buckets: [],
      }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.historyAscending).toEqual([])
        expect(result.val.status).toEqual({ type: "ok" })
      }
    })

    it("should handle single candle", () => {
      const candles = [makeFlatCandle(hour(5), 100)]
      const rangeResult: RangeResult<Candle> = {
        type: "ok",
        effectiveSearchStart: hourDate(5),
        effectiveSearchEnd: hourDate(6),
        earliestDataInDb: hourDate(0),
        buckets: candles,
      }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.historyAscending).toHaveLength(1)
        expect(result.val.historyAscending[0]).toEqual(candles[0])
      }
    })

    it("should preserve candle order", () => {
      const candles = [
        makeFlatCandle(hour(0), 100),
        makeFlatCandle(hour(1), 110),
        makeFlatCandle(hour(2), 120),
        makeFlatCandle(hour(3), 130),
        makeFlatCandle(hour(4), 140),
      ]
      const rangeResult: RangeResult<Candle> = {
        type: "ok",
        effectiveSearchStart: hourDate(0),
        effectiveSearchEnd: hourDate(5),
        earliestDataInDb: hourDate(0),
        buckets: candles,
      }
      const input = Ok(rangeResult)

      const result = mapClosedCandlesResult(input)

      expect(result.ok).toBe(true)
      if (result.ok) {
        for (let i = 0; i < candles.length; i++) {
          expect(result.val.historyAscending[i].timestampMillis).toBe(candles[i].timestampMillis)
        }
      }
    })
  })
})

// ============================================================================
// computeOpenCandle Tests
// ============================================================================

describe("computeOpenCandle", () => {
  describe("when openCandleFromDb is Some", () => {
    it("should return the DB candle", () => {
      const dbCandle = makeFlatCandle(hour(12), 150)
      const history = [makeFlatCandle(hour(11), 100)]

      const result = computeOpenCandle(Some(dbCandle), history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val).toBe(dbCandle)
      }
    })

    it("should prefer DB candle even with different OHLC", () => {
      const dbCandle = makeCandle(hour(12), { o: 100, h: 120, l: 95, c: 115 })
      const history = [makeFlatCandle(hour(11), 200)] // different price

      const result = computeOpenCandle(Some(dbCandle), history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.data.open).toBe(100)
        expect(result.val.data.close).toBe(115)
      }
    })

    it("should return DB candle even with empty history", () => {
      const dbCandle = makeFlatCandle(hour(12), 150)

      const result = computeOpenCandle(Some(dbCandle), [], HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val).toBe(dbCandle)
      }
    })
  })

  describe("when openCandleFromDb is None and history is non-empty", () => {
    it("should construct from last closed candle", () => {
      const history = [
        makeFlatCandle(hour(10), 100),
        makeFlatCandle(hour(11), 110),
      ]

      const result = computeOpenCandle(None, history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.timestampMillis).toBe(hour(12))
        expect(result.val.data.open).toBe(110)
        expect(result.val.data.high).toBe(110)
        expect(result.val.data.low).toBe(110)
        expect(result.val.data.close).toBe(110)
      }
    })

    it("should use close price from last candle for all OHLC", () => {
      const lastCandle = makeCandle(hour(11), { o: 90, h: 120, l: 85, c: 105 })
      const history = [makeFlatCandle(hour(10), 100), lastCandle]

      const result = computeOpenCandle(None, history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.data.open).toBe(105)
        expect(result.val.data.high).toBe(105)
        expect(result.val.data.low).toBe(105)
        expect(result.val.data.close).toBe(105)
      }
    })

    it("should work with single candle history", () => {
      const history = [makeFlatCandle(hour(11), 100)]

      const result = computeOpenCandle(None, history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.timestampMillis).toBe(hour(12))
        expect(result.val.data.close).toBe(100)
      }
    })

    it("should respect bucket width for timestamp advancement", () => {
      const history = [makeFlatCandle(minute(45), 100)]

      const result = computeOpenCandle(None, history, 15 * MINUTE_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.timestampMillis).toBe(minute(60))
      }
    })

    it("should handle 5-minute bucket width", () => {
      const history = [makeFlatCandle(minute(25), 100)]

      const result = computeOpenCandle(None, history, 5 * MINUTE_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.timestampMillis).toBe(minute(30))
      }
    })
  })

  describe("when openCandleFromDb is None and history is empty", () => {
    it("should return None", () => {
      const result = computeOpenCandle(None, [], HOUR_MILLIS)
      expect(result.none).toBe(true)
    })
  })

  describe("price edge cases", () => {
    it("should handle zero close price", () => {
      const history = [makeFlatCandle(hour(11), 0)]

      const result = computeOpenCandle(None, history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.data.close).toBe(0)
      }
    })

    it("should handle very small close price", () => {
      const history = [makeFlatCandle(hour(11), 0.00000001)]

      const result = computeOpenCandle(None, history, HOUR_MILLIS)

      expect(result.some).toBe(true)
      if (result.some) {
        expect(result.val.data.close).toBe(0.00000001)
      }
    })
  })
})

// ============================================================================
// getCandlesInRange Integration Tests (minimal - just smoke tests)
// ============================================================================

describe("getCandlesInRange", () => {
  let mockGetBucketsInRange: Mock

  class MockCache implements ICache {
    async zrange<T>(): Promise<T[]> { return [] }
    async zreplaceRange<T>(): Promise<number> { return 0 }
  }

  beforeEach(() => {
    mockGetBucketsInRange = getBucketsInRange as Mock
    mockGetBucketsInRange.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2024-01-01T12:30:00Z"))
  })

  function createParams(overrides?: Partial<GetCandlesParams<string>>): GetCandlesParams<string> {
    return {
      cacheKeyNamespace: "test",
      start: hourDate(0),
      end: hourDate(12),
      bucketWidthMillis: HOUR_MILLIS,
      entityKey: "test-entity",
      getEarliestPriceDate: vi.fn(async () => Some(hourDate(0))),
      getLatestCandleBefore: vi.fn(async () => None),
      getCandlesInRange: vi.fn(async () => []),
      getOpenCandle: vi.fn(async () => None),
      cache: new MockCache(),
      now: new Date("2024-01-01T12:30:00Z"),
      ...overrides,
    }
  }

  it("should return candles when getBucketsInRange succeeds", async () => {
    const candles = [makeFlatCandle(hour(0), 100), makeFlatCandle(hour(1), 110)]
    mockGetBucketsInRange.mockResolvedValue(Ok({
      type: "ok",
      effectiveSearchStart: hourDate(0),
      effectiveSearchEnd: hourDate(2),
      earliestDataInDb: hourDate(0),
      buckets: candles,
    }))

    const result = await getCandlesInRange(createParams())

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.val.historyAscending).toEqual(candles)
    }
  })

  it("should propagate errors from getBucketsInRange", async () => {
    mockGetBucketsInRange.mockResolvedValue(
      Err(RangeCachedErrors.GetRangeFromDbError("DB error", new Error("fail")))
    )

    const result = await getCandlesInRange(createParams())

    expect(result.err).toBe(true)
  })
})
