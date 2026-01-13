import { describe, it, expect } from "vitest"
import {
  getBucketBoundariesFromEarliestData,
  calculateBucketWidthHours,
  BucketBoundaries,
  GetBucketWidthFromEarliestDataParams,
} from "./index"

const HOUR_MILLIS = 1000 * 60 * 60

// Helper to create a Date at a specific hour offset from a base date
const baseDate = new Date("2024-01-15T00:00:00.000Z")
const hoursFromBase = (hours: number) => new Date(baseDate.getTime() + hours * HOUR_MILLIS)

describe("calculateBucketWidthHours", () => {
  it("should throw if spanHours <= 0", () => {
    expect(() => calculateBucketWidthHours(0, 10)).toThrow("Span hours must be greater than 0")
    expect(() => calculateBucketWidthHours(-5, 10)).toThrow("Span hours must be greater than 0")
  })

  it("should throw if desiredBucketCount <= 0", () => {
    expect(() => calculateBucketWidthHours(24, 0)).toThrow("Desired bucket count must be greater than 0")
    expect(() => calculateBucketWidthHours(24, -5)).toThrow("Desired bucket count must be greater than 0")
  })

  it("should return 1 if span is less than desired bucket count", () => {
    // 5 hours span, want 10 buckets -> floor(5/10) = 0, so return 1
    expect(calculateBucketWidthHours(5, 10)).toBe(1)
  })

  it("should return floor(span / bucketCount)", () => {
    // 24 hours, 10 buckets -> floor(24/10) = 2
    expect(calculateBucketWidthHours(24, 10)).toBe(2)
    // 100 hours, 10 buckets -> floor(100/10) = 10
    expect(calculateBucketWidthHours(100, 10)).toBe(10)
    // 25 hours, 10 buckets -> floor(25/10) = 2
    expect(calculateBucketWidthHours(25, 10)).toBe(2)
  })

  it("should handle exact divisions", () => {
    expect(calculateBucketWidthHours(20, 10)).toBe(2)
    expect(calculateBucketWidthHours(30, 10)).toBe(3)
  })
})

describe("getBucketBoundariesFromEarliestData", () => {
  describe("input validation", () => {
    it("should throw if minBuckets <= 0", () => {
      expect(() =>
        getBucketBoundariesFromEarliestData({
          lookbackHours: 24,
          desiredBucketCount: 10,
          earliestData: hoursFromBase(0),
          minBuckets: 0,
          end: hoursFromBase(24),
        }),
      ).toThrow("Min buckets must be greater than 0")
    })

    it("should throw if minBuckets > desiredBucketCount", () => {
      expect(() =>
        getBucketBoundariesFromEarliestData({
          lookbackHours: 24,
          desiredBucketCount: 5,
          earliestData: hoursFromBase(0),
          minBuckets: 10,
          end: hoursFromBase(24),
        }),
      ).toThrow("Min buckets must be less than or equal to desired bucket count")
    })

    it("should throw if lookbackHours <= 0", () => {
      expect(() =>
        getBucketBoundariesFromEarliestData({
          lookbackHours: 0,
          desiredBucketCount: 10,
          earliestData: hoursFromBase(0),
          minBuckets: 5,
          end: hoursFromBase(24),
        }),
      ).toThrow("Lookback hours must be greater than 0")
    })

    it("should throw if desiredBucketCount <= 0", () => {
      expect(() =>
        getBucketBoundariesFromEarliestData({
          lookbackHours: 24,
          desiredBucketCount: 0,
          earliestData: hoursFromBase(0),
          minBuckets: 0,
          end: hoursFromBase(24),
        }),
      ).toThrow("Min buckets must be greater than 0")
    })
  })

  describe("no data case (earliestData >= end)", () => {
    it("should return minBuckets with 1-hour width when no data exists", () => {
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(30), // after end
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end is ceiled to the hour: already on the hour, so stays at hour 24
      // lastBucketEnd = ceil(hour 24) = hour 25 (next hour boundary)
      // bucketWidth = 1
      // bucketCount = minBuckets = 5
      // lastBucketStart = lastBucketEnd - 1 hour = hour 24
      // firstBucketStart = lastBucketEnd - 5 hours = hour 20
      expect(result.bucketCount).toBe(5)
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(24).getTime())
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(20).getTime())
    })

    it("should ceil end time when calculating boundaries for no-data case", () => {
      // End at 24:30 (half hour past)
      const endTime = new Date(hoursFromBase(24).getTime() + 30 * 60 * 1000)

      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(50), // way after end
        minBuckets: 3,
        end: endTime,
      })

      // ceil(24:30) = hour 25
      expect(result.bucketCount).toBe(3)
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(24).getTime())
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(22).getTime())
    })
  })

  describe("normal cases with sufficient data", () => {
    it("should calculate correct boundaries when data spans full lookback", () => {
      // Lookback 24 hours, want 10 buckets, data starts at hour 0, end at hour 24
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end is ceiled: hour 24 -> hour 25
      // firstBucketStart = end - lookbackHours = hour 25 - 24 = hour 1
      // But earliestData truncated = hour 0
      // trueStart = max(hour 1, hour 0) = hour 1
      // trueLookbackHours = (hour 25 - hour 1) / HOUR_MILLIS = 24 hours
      // trueBucketWidth = floor(24 / 10) = 2
      // trueBucketCount = floor(24 / 2) = 12
      // Since trueBucketWidth > 1, we return with trueStart
      expect(result.bucketCount).toBe(12)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(1).getTime())
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
      // lastBucketStart = end - bucketWidth = hour 25 - 2 = hour 23
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(23).getTime())
    })

    it("should use earliestData as start when it is later than calculated firstBucketStart", () => {
      // Lookback 100 hours, but data only starts at hour 10
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 100,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(10),
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // firstBucketStart = hour 25 - 100 = hour -75
      // earliestTruncated = hour 10
      // trueStart = max(hour -75, hour 10) = hour 10
      // trueLookbackHours = (hour 25 - hour 10) = 15 hours
      // trueBucketWidth = floor(15 / 10) = 1
      // Since trueBucketWidth = 1, we enter the coercion branch
      // trueBucketCount = floor(15 / 1) = 15
      // coercedBucketCount = max(5, 15) = 15
      // coercedFirstBucketStart = hour 25 - 15 = hour 10
      expect(result.bucketCount).toBe(15)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(10).getTime())
    })

    it("should handle bucket width > 1 correctly", () => {
      // 48 hours of data, want 10 buckets
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 48,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(48),
      })

      // end ceiled = hour 49
      // firstBucketStart = hour 49 - 48 = hour 1
      // trueStart = max(hour 1, hour 0) = hour 1
      // trueLookbackHours = 48
      // trueBucketWidth = floor(48 / 10) = 4
      // trueBucketCount = floor(48 / 4) = 12
      expect(result.bucketCount).toBe(12)
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(45).getTime()) // hour 49 - 4
    })
  })

  describe("limited data cases (bucket width = 1)", () => {
    it("should use minBuckets when actual data provides fewer buckets", () => {
      // Only 3 hours of data, want 10 buckets, min 5
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(21), // 3 hours before end
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // firstBucketStart = hour 25 - 24 = hour 1
      // earliestTruncated = hour 21
      // trueStart = max(hour 1, hour 21) = hour 21
      // trueLookbackHours = 4 hours
      // trueBucketWidth = floor(4 / 10) = 0 -> 1
      // trueBucketCount = floor(4 / 1) = 4
      // Since trueBucketWidth = 1:
      // coercedBucketCount = max(5, 4) = 5
      // coercedFirstBucketStart = hour 25 - 5 = hour 20
      expect(result.bucketCount).toBe(5)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(20).getTime())
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(24).getTime())
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
    })

    it("should not exceed actual bucket count when it exceeds minBuckets", () => {
      // 8 hours of data, want 10 buckets, min 5
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(16), // 8 hours before end
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // firstBucketStart = hour 25 - 24 = hour 1
      // earliestTruncated = hour 16
      // trueStart = max(hour 1, hour 16) = hour 16
      // trueLookbackHours = 9 hours
      // trueBucketWidth = floor(9 / 10) = 0 -> 1
      // trueBucketCount = floor(9 / 1) = 9
      // Since trueBucketWidth = 1:
      // coercedBucketCount = max(5, 9) = 9
      // coercedFirstBucketStart = hour 25 - 9 = hour 16
      expect(result.bucketCount).toBe(9)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(16).getTime())
    })
  })

  describe("date truncation and ceiling behavior", () => {
    it("should truncate earliestData to the hour", () => {
      // earliestData at 10:45
      const earliestWithMinutes = new Date(hoursFromBase(10).getTime() + 45 * 60 * 1000)

      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 100,
        desiredBucketCount: 10,
        earliestData: earliestWithMinutes,
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // earliestTruncated should be hour 10 (not 10:45)
      // end ceiled = hour 25
      // trueStart = max(hour -75, hour 10) = hour 10
      // trueLookbackHours = 15
      // trueBucketWidth = 1
      // coercedBucketCount = max(5, 15) = 15
      // firstBucketStart = hour 25 - 15 = hour 10
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(10).getTime())
    })

    it("should ceil end time to the next hour", () => {
      // end at 24:30
      const endWithMinutes = new Date(hoursFromBase(24).getTime() + 30 * 60 * 1000)

      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: endWithMinutes,
      })

      // ceil(24:30) = hour 25
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
    })

    it("should handle end time exactly on the hour", () => {
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(24), // exactly on the hour
      })

      // When on the hour, truncateHour returns the same, then we add HOUR_MILLIS
      // So ceil(hour 24) = hour 25
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(25).getTime())
    })
  })

  describe("edge cases", () => {
    it("should handle when earliestData equals calculated firstBucketStart", () => {
      // If lookback would start exactly where data begins
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(1), // exactly where firstBucketStart would be after ceil
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // firstBucketStart = hour 25 - 24 = hour 1
      // earliestTruncated = hour 1
      // trueStart = max(hour 1, hour 1) = hour 1
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(1).getTime())
    })

    it("should handle minBuckets equal to desiredBucketCount", () => {
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 5,
        earliestData: hoursFromBase(22), // only 2 hours of data
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // trueStart = hour 22
      // trueLookbackHours = 3
      // trueBucketWidth = 1
      // trueBucketCount = 3
      // coercedBucketCount = max(5, 3) = 5
      expect(result.bucketCount).toBe(5)
    })

    it("should handle very small lookback", () => {
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 1,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 1,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // firstBucketStart = hour 25 - 1 = hour 24
      // trueStart = max(hour 24, hour 0) = hour 24
      // trueLookbackHours = 1
      // trueBucketWidth = 1
      // trueBucketCount = 1
      // coercedBucketCount = max(1, 1) = 1
      expect(result.bucketCount).toBe(1)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(24).getTime())
    })

    it("should handle earliestData just before end", () => {
      // earliestData at 23:30, end at 24:00
      const earliestData = new Date(hoursFromBase(23).getTime() + 30 * 60 * 1000)

      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 24,
        desiredBucketCount: 10,
        earliestData: earliestData,
        minBuckets: 5,
        end: hoursFromBase(24),
      })

      // end ceiled = hour 25
      // earliestTruncated = hour 23
      // trueLookbackHours = 2
      // trueBucketWidth = 1
      // trueBucketCount = 2
      // coercedBucketCount = max(5, 2) = 5
      expect(result.bucketCount).toBe(5)
    })
  })

  describe("bucket count accuracy verification", () => {
    it("should return exactly desiredBucketCount when data spans exactly desiredBucketCount hours", () => {
      // 10 hours of data, want 10 buckets -> width = 1, count = 10
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 10,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(9), // 9 hours from base, ceil to hour 10
      })

      // end ceiled = hour 10
      // firstBucketStart = hour 10 - 10 = hour 0
      // trueStart = max(hour 0, hour 0) = hour 0
      // trueLookbackHours = 10
      // trueBucketWidth = floor(10 / 10) = 1
      // trueBucketCount = floor(10 / 1) = 10
      // Since trueBucketWidth = 1: coercedBucketCount = max(5, 10) = 10
      expect(result.bucketCount).toBe(10)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(0).getTime())
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(10).getTime())
    })

    it("should return exactly desiredBucketCount when data spans exactly 2x desiredBucketCount hours", () => {
      // 20 hours of data, want 10 buckets -> width = 2, count = 10
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 20,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(19), // ceil to hour 20
      })

      // end ceiled = hour 20
      // firstBucketStart = hour 20 - 20 = hour 0
      // trueStart = hour 0
      // trueLookbackHours = 20
      // trueBucketWidth = floor(20 / 10) = 2
      // trueBucketCount = floor(20 / 2) = 10
      expect(result.bucketCount).toBe(10)
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(18).getTime()) // hour 20 - 2
    })

    it("should produce buckets that cover the full time span", () => {
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 30,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(29), // ceil to hour 30
      })

      // end ceiled = hour 30
      // trueLookbackHours = 30
      // trueBucketWidth = floor(30 / 10) = 3
      // trueBucketCount = floor(30 / 3) = 10
      expect(result.bucketCount).toBe(10)

      // Verify: bucketCount * implied_width should equal the span
      const span = result.lastBucketEnd.getTime() - result.firstBucketStart.getTime()
      const impliedWidth = span / result.bucketCount / HOUR_MILLIS
      expect(impliedWidth).toBe(3)
    })

    it("should handle odd bucket counts correctly", () => {
      // 21 hours, 10 desired buckets
      const result = getBucketBoundariesFromEarliestData({
        lookbackHours: 21,
        desiredBucketCount: 10,
        earliestData: hoursFromBase(0),
        minBuckets: 5,
        end: hoursFromBase(20), // ceil to hour 21
      })

      // end ceiled = hour 21
      // firstBucketStart = hour 21 - 21 = hour 0
      // trueStart = max(hour 0, hour 0) = hour 0
      // trueLookbackHours = 21
      // trueBucketWidth = floor(21 / 10) = 2
      // trueBucketCount = floor(21 / 2) = 10
      // 10 buckets * 2 hours = 20 hours, starting from hour 0
      // Buckets: [0,2), [2,4), [4,6), [6,8), [8,10), [10,12), [12,14), [14,16), [16,18), [18,20)
      // Wait - lastBucketEnd should be hour 21, so last bucket is [19, 21)
      expect(result.bucketCount).toBe(10)
      expect(result.firstBucketStart.getTime()).toBe(hoursFromBase(0).getTime())
      expect(result.lastBucketStart.getTime()).toBe(hoursFromBase(19).getTime()) // hour 21 - 2
      expect(result.lastBucketEnd.getTime()).toBe(hoursFromBase(21).getTime())
    })
  })
})
