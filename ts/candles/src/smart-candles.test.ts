import { describe, it, expect, vi, beforeEach, Mock } from "vitest"
import { None, Ok, Some, Err } from "ts-results"
import {
  CandleWidth,
  computeBucketWidth,
  computeEffectiveSearchRange,
  computeDomainBounds,
  buildPaddedHistory,
  computeOpenCandle,
  generatePaddingCandles,
  makeDefaultCandleCtr,
  DomainBounds,
  getCandlesWithPadding,
  GetCandlesWithPaddingParams,
} from "./smart-candles"
import { Candle, ICache } from "./types"

// Mock getCandlesInRange
vi.mock("./get-candles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./get-candles")>()
  return {
    ...actual,
    getCandlesInRange: vi.fn(),
  }
})

import { getCandlesInRange } from "./get-candles"

// ============================================================================
// Test Helpers
// ============================================================================

const MINUTE_MILLIS = 60 * 1000
const HOUR_MILLIS = 60 * MINUTE_MILLIS
const DAY_MILLIS = 24 * HOUR_MILLIS

const BASE_TS = new Date("2024-01-01T00:00:00Z").getTime()
const hour = (n: number) => BASE_TS + n * HOUR_MILLIS
const day = (n: number) => BASE_TS + n * DAY_MILLIS

function makeFlatCandle(timestampMillis: number, price: number): Candle {
  return {
    timestampMillis,
    data: { open: price, high: price, low: price, close: price },
  }
}

function makeCandle(timestampMillis: number, ohlc: { o: number; h: number; l: number; c: number }): Candle {
  return {
    timestampMillis,
    data: { open: ohlc.o, high: ohlc.h, low: ohlc.l, close: ohlc.c },
  }
}

// ============================================================================
// computeBucketWidth Tests
// ============================================================================

describe("computeBucketWidth", () => {
  describe("short ranges (< 1 hour)", () => {
    it("should return FIVE_MINUTES for ranges under 1 hour", () => {
      expect(computeBucketWidth(30 * MINUTE_MILLIS, 250)).toBe(CandleWidth.FIVE_MINUTES)
      expect(computeBucketWidth(59 * MINUTE_MILLIS, 250)).toBe(CandleWidth.FIVE_MINUTES)
      expect(computeBucketWidth(1, 250)).toBe(CandleWidth.FIVE_MINUTES)
    })
  })

  describe("boundary conditions (the <= fix)", () => {
    it("should return FIVE_MINUTES when ideal width is exactly 5 minutes", () => {
      // 250 candles * 5 min = 1250 min = 20.83 hours
      // If range = 20.83 hours, ideal = 5 min exactly
      const rangeMillis = 250 * 5 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.FIVE_MINUTES)
    })

    it("should return FIFTEEN_MINUTES when ideal width is exactly 15 minutes", () => {
      const rangeMillis = 250 * 15 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.FIFTEEN_MINUTES)
    })

    it("should return THIRTY_MINUTES when ideal width is exactly 30 minutes", () => {
      const rangeMillis = 250 * 30 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.THIRTY_MINUTES)
    })

    it("should return ONE_HOUR when ideal width is exactly 60 minutes", () => {
      const rangeMillis = 250 * 60 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.ONE_HOUR)
    })

    it("should return TWO_HOURS when ideal width is exactly 120 minutes", () => {
      const rangeMillis = 250 * 120 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.TWO_HOURS)
    })

    it("should return FOUR_HOURS when ideal width is exactly 240 minutes", () => {
      const rangeMillis = 250 * 240 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.FOUR_HOURS)
    })

    it("should return EIGHT_HOURS when ideal width is exactly 480 minutes", () => {
      const rangeMillis = 250 * 480 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.EIGHT_HOURS)
    })

    it("should return TWELVE_HOURS when ideal width is exactly 720 minutes", () => {
      const rangeMillis = 250 * 720 * MINUTE_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.TWELVE_HOURS)
    })
  })

  describe("just above boundaries", () => {
    it("should return FIFTEEN_MINUTES when ideal width is 5.01 minutes", () => {
      // (range_hours / 250) * 60 = 5.01
      // range_hours = 5.01 * 250 / 60 = 20.875
      const rangeMillis = 20.875 * HOUR_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.FIFTEEN_MINUTES)
    })

    it("should return THIRTY_MINUTES when ideal width is 15.01 minutes", () => {
      const rangeMillis = (15.01 * 250 / 60) * HOUR_MILLIS
      expect(computeBucketWidth(rangeMillis, 250)).toBe(CandleWidth.THIRTY_MINUTES)
    })
  })

  describe("typical use cases", () => {
    it("should return ONE_HOUR for 7-day range with 250 target", () => {
      // 7 days = 168 hours
      // ideal = 168 / 250 * 60 = 40.32 minutes
      expect(computeBucketWidth(7 * DAY_MILLIS, 250)).toBe(CandleWidth.ONE_HOUR)
    })

    it("should return FOUR_HOURS for 30-day range with 250 target", () => {
      // 30 days = 720 hours
      // ideal = 720 / 250 * 60 = 172.8 minutes = 2.88 hours
      expect(computeBucketWidth(30 * DAY_MILLIS, 250)).toBe(CandleWidth.FOUR_HOURS)
    })

    it("should return ONE_DAY for 180-day range with 250 target", () => {
      // 180 days = 4320 hours
      // ideal = 4320 / 250 * 60 = 1036.8 minutes = 17.28 hours
      expect(computeBucketWidth(180 * DAY_MILLIS, 250)).toBe(CandleWidth.ONE_DAY)
    })

    it("should return FIVE_MINUTES for 24-hour range with 250 target", () => {
      // 24 hours / 250 * 60 = 5.76 minutes
      expect(computeBucketWidth(24 * HOUR_MILLIS, 250)).toBe(CandleWidth.FIFTEEN_MINUTES)
    })
  })

  describe("different target counts", () => {
    it("should return smaller buckets with larger target count", () => {
      const range = 7 * DAY_MILLIS
      // With 500 target: 168 / 500 * 60 = 20.16 min → THIRTY_MINUTES
      expect(computeBucketWidth(range, 500)).toBe(CandleWidth.THIRTY_MINUTES)
    })

    it("should return larger buckets with smaller target count", () => {
      const range = 7 * DAY_MILLIS
      // With 100 target: 168 / 100 * 60 = 100.8 min → TWO_HOURS
      expect(computeBucketWidth(range, 100)).toBe(CandleWidth.TWO_HOURS)
    })
  })

  describe("edge cases", () => {
    it("should return ONE_DAY for very large ranges", () => {
      expect(computeBucketWidth(365 * DAY_MILLIS, 250)).toBe(CandleWidth.ONE_DAY)
      expect(computeBucketWidth(1000 * DAY_MILLIS, 250)).toBe(CandleWidth.ONE_DAY)
    })

    it("should handle target count of 1", () => {
      // Entire range in one bucket → ONE_DAY
      expect(computeBucketWidth(24 * HOUR_MILLIS, 1)).toBe(CandleWidth.ONE_DAY)
    })
  })
})

// ============================================================================
// computeEffectiveSearchRange Tests
// ============================================================================

describe("computeEffectiveSearchRange", () => {
  describe("when earliest data is before desired start", () => {
    it("should use desired start", () => {
      const now = day(100)
      const earliest = day(0)
      const lookBackDays = 7

      const result = computeEffectiveSearchRange(now, lookBackDays, earliest)

      expect(result.startMillis).toBe(day(93)) // 100 - 7
      expect(result.endMillis).toBe(now)
      expect(result.rangeMillis).toBe(7 * DAY_MILLIS)
    })
  })

  describe("when earliest data is after desired start", () => {
    it("should clamp to earliest data", () => {
      const now = day(100)
      const earliest = day(95) // only 5 days of data
      const lookBackDays = 30

      const result = computeEffectiveSearchRange(now, lookBackDays, earliest)

      expect(result.startMillis).toBe(earliest)
      expect(result.endMillis).toBe(now)
      expect(result.rangeMillis).toBe(5 * DAY_MILLIS)
    })
  })

  describe("when earliest equals desired start", () => {
    it("should use that value", () => {
      const now = day(100)
      const earliest = day(93)
      const lookBackDays = 7

      const result = computeEffectiveSearchRange(now, lookBackDays, earliest)

      expect(result.startMillis).toBe(day(93))
      expect(result.rangeMillis).toBe(7 * DAY_MILLIS)
    })
  })

  describe("when earliest is after now", () => {
    it("should return zero range", () => {
      const now = day(100)
      const earliest = day(105) // future data (shouldn't happen, but handle it)
      const lookBackDays = 7

      const result = computeEffectiveSearchRange(now, lookBackDays, earliest)

      expect(result.startMillis).toBe(earliest)
      expect(result.endMillis).toBe(now)
      expect(result.rangeMillis).toBe(0) // max(0, negative) = 0
    })
  })

  describe("fractional days", () => {
    it("should handle sub-day lookback", () => {
      const now = hour(100)
      const earliest = hour(0)
      const lookBackDays = 0.5 // 12 hours

      const result = computeEffectiveSearchRange(now, lookBackDays, earliest)

      expect(result.rangeMillis).toBe(12 * HOUR_MILLIS)
    })
  })
})

// ============================================================================
// computeDomainBounds Tests
// ============================================================================

describe("computeDomainBounds", () => {
  describe("bucket alignment", () => {
    it("should floor now to bucket boundary", () => {
      const now = hour(12) + 30 * MINUTE_MILLIS // 12:30
      const result = computeDomainBounds(now, hour(0), HOUR_MILLIS, 24 * HOUR_MILLIS)

      expect(result.lastClosedEndMillis).toBe(hour(12)) // floored to 12:00
    })

    it("should maintain alignment when now is on boundary", () => {
      const now = hour(12) // exactly 12:00
      const result = computeDomainBounds(now, hour(0), HOUR_MILLIS, 24 * HOUR_MILLIS)

      expect(result.lastClosedEndMillis).toBe(hour(12))
    })

    it("should work with 15-minute buckets", () => {
      const now = hour(12) + 37 * MINUTE_MILLIS // 12:37
      const result = computeDomainBounds(now, hour(0), 15 * MINUTE_MILLIS, 24 * HOUR_MILLIS)

      expect(result.lastClosedEndMillis).toBe(hour(12) + 30 * MINUTE_MILLIS) // 12:30
    })
  })

  describe("padding detection", () => {
    it("should detect when padding is needed", () => {
      const now = hour(12)
      const searchStart = hour(10) // only 2 hours of data
      const minSpan = 24 * HOUR_MILLIS

      const result = computeDomainBounds(now, searchStart, HOUR_MILLIS, minSpan)

      expect(result.needsPadding).toBe(true)
      expect(result.domainStartMillis).toBe(hour(12) - 24 * HOUR_MILLIS) // extends back 24h
    })

    it("should not pad when range exceeds minimum", () => {
      const now = hour(48)
      const searchStart = hour(0) // 48 hours of data
      const minSpan = 24 * HOUR_MILLIS

      const result = computeDomainBounds(now, searchStart, HOUR_MILLIS, minSpan)

      expect(result.needsPadding).toBe(false)
      expect(result.domainStartMillis).toBe(hour(0))
    })

    it("should not pad when range equals minimum exactly", () => {
      const now = hour(24)
      const searchStart = hour(0) // exactly 24 hours
      const minSpan = 24 * HOUR_MILLIS

      const result = computeDomainBounds(now, searchStart, HOUR_MILLIS, minSpan)

      expect(result.needsPadding).toBe(false)
      expect(result.domainStartMillis).toBe(hour(0))
    })
  })

  describe("domain calculation", () => {
    it("should extend domain backwards when padding needed", () => {
      const now = hour(12)
      const searchStart = hour(11) // only 1 hour
      const minSpan = 6 * HOUR_MILLIS

      const result = computeDomainBounds(now, searchStart, HOUR_MILLIS, minSpan)

      expect(result.domainStartMillis).toBe(hour(6)) // 12 - 6
      expect(result.lastClosedEndMillis).toBe(hour(12))
    })
  })
})

// ============================================================================
// generatePaddingCandles Tests
// ============================================================================

describe("generatePaddingCandles", () => {
  const defaultCtr = makeDefaultCandleCtr(100)

  describe("basic generation", () => {
    it("should generate candles from start to end (exclusive)", () => {
      const candles = generatePaddingCandles(hour(0), hour(3), HOUR_MILLIS, defaultCtr)

      expect(candles.length).toBe(3)
      expect(candles[0].timestampMillis).toBe(hour(0))
      expect(candles[1].timestampMillis).toBe(hour(1))
      expect(candles[2].timestampMillis).toBe(hour(2))
    })

    it("should return empty array when start equals end", () => {
      const candles = generatePaddingCandles(hour(5), hour(5), HOUR_MILLIS, defaultCtr)
      expect(candles.length).toBe(0)
    })

    it("should return empty array when start is after end", () => {
      const candles = generatePaddingCandles(hour(10), hour(5), HOUR_MILLIS, defaultCtr)
      expect(candles.length).toBe(0)
    })
  })

  describe("alignment", () => {
    it("should floor start to bucket boundary", () => {
      // Start at 12:37, should align to 12:00
      const start = hour(12) + 37 * MINUTE_MILLIS
      const candles = generatePaddingCandles(start, hour(15), HOUR_MILLIS, defaultCtr)

      expect(candles[0].timestampMillis).toBe(hour(12))
    })

    it("should keep start if already aligned", () => {
      const candles = generatePaddingCandles(hour(12), hour(15), HOUR_MILLIS, defaultCtr)
      expect(candles[0].timestampMillis).toBe(hour(12))
    })

    it("should work with 15-minute alignment", () => {
      const start = hour(0) + 7 * MINUTE_MILLIS // 00:07
      const end = hour(1)
      const candles = generatePaddingCandles(start, end, 15 * MINUTE_MILLIS, defaultCtr)

      expect(candles.length).toBe(4) // 00:00, 00:15, 00:30, 00:45
      expect(candles[0].timestampMillis).toBe(hour(0))
    })
  })

  describe("candle values", () => {
    it("should use provided constructor for all candles", () => {
      const ctr = makeDefaultCandleCtr(42.5)
      const candles = generatePaddingCandles(hour(0), hour(2), HOUR_MILLIS, ctr)

      for (const c of candles) {
        expect(c.data.open).toBe(42.5)
        expect(c.data.high).toBe(42.5)
        expect(c.data.low).toBe(42.5)
        expect(c.data.close).toBe(42.5)
      }
    })
  })

  describe("different bucket widths", () => {
    it("should work with 5-minute buckets", () => {
      const candles = generatePaddingCandles(hour(0), hour(0) + 15 * MINUTE_MILLIS, 5 * MINUTE_MILLIS, defaultCtr)
      expect(candles.length).toBe(3)
    })

    it("should work with 4-hour buckets", () => {
      const candles = generatePaddingCandles(hour(0), hour(12), 4 * HOUR_MILLIS, defaultCtr)
      expect(candles.length).toBe(3) // 0, 4, 8
    })

    it("should work with 1-day buckets", () => {
      const candles = generatePaddingCandles(day(0), day(7), DAY_MILLIS, defaultCtr)
      expect(candles.length).toBe(7)
    })
  })
})

// ============================================================================
// makeDefaultCandleCtr Tests
// ============================================================================

describe("makeDefaultCandleCtr", () => {
  it("should create candles with all OHLC equal to default price", () => {
    const ctr = makeDefaultCandleCtr(100)
    const candle = ctr(hour(5))

    expect(candle.data.open).toBe(100)
    expect(candle.data.high).toBe(100)
    expect(candle.data.low).toBe(100)
    expect(candle.data.close).toBe(100)
  })

  it("should set correct timestamp", () => {
    const ctr = makeDefaultCandleCtr(100)
    const candle = ctr(hour(42))

    expect(candle.timestampMillis).toBe(hour(42))
  })

  it("should handle zero price", () => {
    const ctr = makeDefaultCandleCtr(0)
    const candle = ctr(hour(0))

    expect(candle.data.close).toBe(0)
  })

  it("should handle very small prices", () => {
    const ctr = makeDefaultCandleCtr(0.00000001)
    const candle = ctr(hour(0))

    expect(candle.data.close).toBe(0.00000001)
  })

  it("should handle negative prices", () => {
    const ctr = makeDefaultCandleCtr(-50)
    const candle = ctr(hour(0))

    expect(candle.data.close).toBe(-50)
  })
})

// ============================================================================
// buildPaddedHistory Tests
// ============================================================================

describe("buildPaddedHistory", () => {
  const defaultCtr = makeDefaultCandleCtr(1.0)

  describe("when realCandles is empty", () => {
    it("should fill entire domain with defaults when needsPadding is true", () => {
      const domain: DomainBounds = {
        domainStartMillis: hour(0),
        lastClosedEndMillis: hour(6),
        needsPadding: true,
      }

      const result = buildPaddedHistory([], domain, HOUR_MILLIS, hour(10), defaultCtr)

      expect(result.candles.length).toBe(6)
      expect(result.status).toEqual({ type: "left-padded", earliestRealCandleMillis: hour(10) })
    })

    it("should fill domain with no-data-at-all status when needsPadding is false", () => {
      const domain: DomainBounds = {
        domainStartMillis: hour(0),
        lastClosedEndMillis: hour(6),
        needsPadding: false,
      }

      const result = buildPaddedHistory([], domain, HOUR_MILLIS, hour(0), defaultCtr)

      expect(result.candles.length).toBe(6)
      expect(result.status).toEqual({ type: "no-data-at-all" })
    })
  })

  describe("when realCandles starts after domain start", () => {
    it("should prepend padding candles", () => {
      const domain: DomainBounds = {
        domainStartMillis: hour(0),
        lastClosedEndMillis: hour(10),
        needsPadding: true,
      }
      const realCandles = [
        makeFlatCandle(hour(5), 100),
        makeFlatCandle(hour(6), 110),
      ]

      const result = buildPaddedHistory(realCandles, domain, HOUR_MILLIS, hour(5), defaultCtr)

      // Should have 5 padding (0,1,2,3,4) + 2 real = 7 total
      expect(result.candles.length).toBe(7)
      expect(result.candles[0].timestampMillis).toBe(hour(0))
      expect(result.candles[0].data.close).toBe(1.0) // default
      expect(result.candles[5].timestampMillis).toBe(hour(5))
      expect(result.candles[5].data.close).toBe(100) // real
      expect(result.status).toEqual({ type: "left-padded", earliestRealCandleMillis: hour(5) })
    })
  })

  describe("when realCandles covers domain start", () => {
    it("should return real candles with ok status", () => {
      const domain: DomainBounds = {
        domainStartMillis: hour(0),
        lastClosedEndMillis: hour(5),
        needsPadding: false,
      }
      const realCandles = [
        makeFlatCandle(hour(0), 100),
        makeFlatCandle(hour(1), 110),
        makeFlatCandle(hour(2), 120),
      ]

      const result = buildPaddedHistory(realCandles, domain, HOUR_MILLIS, hour(0), defaultCtr)

      expect(result.candles).toEqual(realCandles)
      expect(result.status).toEqual({ type: "ok" })
    })
  })

  describe("alignment edge cases", () => {
    it("should handle unaligned domain start by flooring in generatePaddingCandles", () => {
      const domain: DomainBounds = {
        domainStartMillis: hour(0) + 30 * MINUTE_MILLIS, // unaligned
        lastClosedEndMillis: hour(5),
        needsPadding: true,
      }
      const realCandles = [makeFlatCandle(hour(3), 100)]

      const result = buildPaddedHistory(realCandles, domain, HOUR_MILLIS, hour(3), defaultCtr)

      // Padding from floor(0:30) = 0:00 to 3:00 = 3 candles + 1 real = 4
      expect(result.candles.length).toBe(4)
      expect(result.candles[0].timestampMillis).toBe(hour(0))
    })
  })
})

// ============================================================================
// computeOpenCandle Tests (smart-candles version - always returns a candle)
// ============================================================================

describe("computeOpenCandle (smart-candles)", () => {
  const defaultCtr = makeDefaultCandleCtr(1.0)

  describe("when realOpenCandle is Some", () => {
    it("should return the real open candle", () => {
      const realOpen = makeFlatCandle(hour(12), 150)
      const history = [makeFlatCandle(hour(11), 100)]

      const result = computeOpenCandle(Some(realOpen), history, HOUR_MILLIS, defaultCtr, hour(12))

      expect(result).toBe(realOpen)
    })
  })

  describe("when realOpenCandle is None but history exists", () => {
    it("should construct from last closed candle", () => {
      const history = [
        makeFlatCandle(hour(10), 100),
        makeFlatCandle(hour(11), 110),
      ]

      const result = computeOpenCandle(None, history, HOUR_MILLIS, defaultCtr, hour(12))

      expect(result.timestampMillis).toBe(hour(12))
      expect(result.data.open).toBe(110)
      expect(result.data.close).toBe(110)
    })

    it("should use close price from last candle with OHLC variation", () => {
      const history = [makeCandle(hour(11), { o: 90, h: 120, l: 85, c: 105 })]

      const result = computeOpenCandle(None, history, HOUR_MILLIS, defaultCtr, hour(12))

      expect(result.data.open).toBe(105)
      expect(result.data.high).toBe(105)
      expect(result.data.low).toBe(105)
      expect(result.data.close).toBe(105)
    })
  })

  describe("when realOpenCandle is None and history is empty", () => {
    it("should return default candle at openBucketStartMillis", () => {
      const result = computeOpenCandle(None, [], HOUR_MILLIS, defaultCtr, hour(12))

      expect(result.timestampMillis).toBe(hour(12))
      expect(result.data.close).toBe(1.0) // default price
    })

    it("should use correct timestamp from openBucketStartMillis", () => {
      const result = computeOpenCandle(None, [], HOUR_MILLIS, defaultCtr, hour(99))

      expect(result.timestampMillis).toBe(hour(99))
    })
  })
})

// ============================================================================
// getCandlesWithPadding Integration Tests (minimal)
// ============================================================================

describe("getCandlesWithPadding", () => {
  let mockGetCandlesInRange: Mock

  class MockCache implements ICache {
    async zrange<T>(): Promise<T[]> { return [] }
    async zreplaceRange<T>(): Promise<number> { return 0 }
  }

  beforeEach(() => {
    mockGetCandlesInRange = getCandlesInRange as Mock
    mockGetCandlesInRange.mockReset()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2024-01-10T12:30:00Z"))
  })

  function createParams(overrides?: Partial<GetCandlesWithPaddingParams<string>>): GetCandlesWithPaddingParams<string> {
    return {
      cacheKeyNamespace: "test",
      entityKey: "test-entity",
      defaultPrice: 1.0,
      lookBackDays: 7,
      now: new Date("2024-01-10T12:30:00Z"),
      getEarliestPriceDate: vi.fn(async () => Some(new Date("2024-01-01T00:00:00Z"))),
      getLatestCandleBefore: vi.fn(async () => None),
      getCandlesInRange: vi.fn(async () => []),
      getOpenCandle: vi.fn(async () => None),
      cache: new MockCache(),
      ...overrides,
    }
  }

  it("should throw when lookBackDays is 0", async () => {
    const params = createParams({ lookBackDays: 0 })
    await expect(getCandlesWithPadding(params)).rejects.toThrow("lookBackDays must be greater than 0")
  })

  it("should throw when lookBackDays is negative", async () => {
    const params = createParams({ lookBackDays: -5 })
    await expect(getCandlesWithPadding(params)).rejects.toThrow("lookBackDays must be greater than 0")
  })

  it("should handle no-data-at-all case (earliest returns None)", async () => {
    const params = createParams({
      getEarliestPriceDate: vi.fn(async () => None),
    })

    const result = await getCandlesWithPadding(params)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.val.status.type).toBe("no-data-at-all")
      expect(result.val.historyAscending.length).toBeGreaterThan(0) // should have padding
      expect(result.val.openCandle).toBeDefined()
    }
  })

  it("should return candles when getCandlesInRange succeeds", async () => {
    const candles = [makeFlatCandle(hour(0), 100), makeFlatCandle(hour(1), 110)]
    mockGetCandlesInRange.mockResolvedValue(Ok({
      historyAscending: candles,
      openCandle: None,
      status: { type: "ok" },
    }))

    const result = await getCandlesWithPadding(createParams())

    expect(result.ok).toBe(true)
  })

  it("should propagate errors from getCandlesInRange", async () => {
    mockGetCandlesInRange.mockResolvedValue(
      Err({ type: "internal-range-cache-error", inner: {} })
    )

    const result = await getCandlesWithPadding(createParams())

    expect(result.err).toBe(true)
  })
})
