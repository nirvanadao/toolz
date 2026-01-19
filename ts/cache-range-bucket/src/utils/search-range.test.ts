import { describe, it, expect } from "vitest"
import { None, Some } from "ts-results"
import { findEffectiveSearchRange } from "./search-range"

const HOUR_MS = 60 * 60 * 1000

// Helper to create dates at specific times on a fixed day
const utc = (hour: number, minute = 0) =>
  new Date(Date.UTC(2024, 0, 15, hour, minute, 0, 0))

describe("findEffectiveSearchRange", () => {
  const defaultParams = {
    start: utc(10),
    end: utc(14),
    now: utc(20),
    bucketWidthMillis: HOUR_MS,
  }

  describe("no data in database", () => {
    it("returns no-data-in-db when earliest is None", () => {
      const result = findEffectiveSearchRange(defaultParams)(None)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("no-data-in-db")
      }
    })
  })

  describe("search range ends before earliest data", () => {
    it("returns search-range-ends-before-earliest when earliest is after search end", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      // Earliest data is at 16:00, but search ends at 14:00
      const earliestDataInDb = Some(utc(16))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("search-range-ends-before-earliest")
        if (result.val.type === "search-range-ends-before-earliest") {
          expect(result.val.earliestDataInDb.getTime()).toBe(utc(16).getTime())
        }
      }
    })

    it("returns search-range-ends-before-earliest when earliest equals last closed bucket start + 1ms", () => {
      const params = {
        start: utc(10),
        end: utc(14),      // floors to 14:00, last closed bucket start = 13:00
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      // Earliest data is at 13:00:00.001 - just after the last closed bucket start
      const earliestDataInDb = Some(new Date(utc(13).getTime() + 1))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("search-range-ends-before-earliest")
      }
    })
  })

  describe("normal search range", () => {
    it("returns ok with correct range when earliest is before search start", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      // Earliest data is at 8:00, before search start
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          // effective search start should be 10:00 (requested start, not earliest)
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(10).getTime())
          // last closed bucket start should be 13:00 (14:00 - 1 hour)
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(13).getTime())
          // last closed bucket end should be 14:00
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(utc(14).getTime())
          expect(result.val.earliestDataInDb.getTime()).toBe(utc(8).getTime())
        }
      }
    })

    it("returns ok with clamped start when earliest is after search start", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      // Earliest data is at 12:00, after search start
      const earliestDataInDb = Some(utc(12))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          // effective search start should be 12:00 (earliest, not requested start)
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(12).getTime())
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(13).getTime())
          expect(result.val.earliestDataInDb.getTime()).toBe(utc(12).getTime())
        }
      }
    })

    it("returns ok when earliest equals search start", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(10))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(10).getTime())
        }
      }
    })

    it("returns ok when earliest equals last closed bucket start", () => {
      const params = {
        start: utc(10),
        end: utc(14),      // last closed bucket start = 13:00
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(13))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          // effective search start = 13:00 (earliest)
          // last closed bucket start = 13:00
          // This is a valid single-bucket range
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(13).getTime())
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(13).getTime())
        }
      }
    })
  })

  describe("clamping to now", () => {
    it("clamps end to now when end is in the future", () => {
      const params = {
        start: utc(10),
        end: utc(18),      // in the future relative to now
        now: utc(14, 30),  // 14:30
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          // end clamped to 14:30, floored to 14:00
          // last closed bucket start = 13:00
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(13).getTime())
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(utc(14).getTime())
        }
      }
    })
  })

  describe("different bucket widths", () => {
    it("works with 15-minute buckets", () => {
      const QUARTER_HOUR_MS = 15 * 60 * 1000
      const params = {
        start: utc(10, 7),   // 10:07
        end: utc(11, 22),    // 11:22
        now: utc(14),
        bucketWidthMillis: QUARTER_HOUR_MS,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          // 10:07 floors to 10:00
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(10, 0).getTime())
          // 11:22 floors to 11:15, last closed bucket start = 11:00
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(11, 0).getTime())
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(utc(11, 15).getTime())
        }
      }
    })

    it("works with 4-hour buckets", () => {
      const FOUR_HOUR_MS = 4 * HOUR_MS
      const params = {
        start: utc(9),    // floors to 08:00
        end: utc(15),     // floors to 12:00
        now: utc(20),
        bucketWidthMillis: FOUR_HOUR_MS,
      }
      const earliestDataInDb = Some(utc(4))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(8).getTime())
          // 15:00 floors to 12:00, last closed bucket start = 08:00 (12:00 - 4 hours)
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(8).getTime())
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(utc(12).getTime())
        }
      }
    })
  })

  describe("edge cases", () => {
    it("handles single closed bucket range", () => {
      // Request 10:00-11:00 when now is 14:00
      // This should give exactly one bucket: the 10:00 bucket (which ends at 11:00)
      const params = {
        start: utc(10),
        end: utc(11),  // floors to 11:00, last closed bucket start = 10:00
        now: utc(14),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(10).getTime())
          expect(result.val.range.lastClosedBucketStartInclusive.getTime()).toBe(utc(10).getTime())
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(utc(11).getTime())
        }
      }
    })

    it("returns search-range-ends-before-earliest when range is within open bucket", () => {
      // Request 10:15-10:45 when now is 10:30
      // The last closed bucket ends at 10:00 (start=9:00)
      // effectiveSearchStart=10:00 > lastClosedBucketStart=9:00
      const params = {
        start: utc(10, 15),
        end: utc(10, 45),
        now: utc(10, 30),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        // This is correct - there are no closed buckets in the range 10:15-10:45
        expect(result.val.type).toBe("search-range-ends-before-earliest")
      }
    })

    it("handles range spanning midnight", () => {
      const params = {
        start: utc(22, 30),
        end: new Date(Date.UTC(2024, 0, 16, 2, 30)), // 02:30 next day
        now: new Date(Date.UTC(2024, 0, 16, 10, 0)),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(20))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("ok")
        if (result.val.type === "ok") {
          expect(result.val.range.firstBucketStartInclusive.getTime()).toBe(utc(22).getTime())
          expect(result.val.range.lastClosedBucketEndExclusive.getTime()).toBe(
            new Date(Date.UTC(2024, 0, 16, 2, 0)).getTime()
          )
        }
      }
    })
  })

  describe("bounds validation errors", () => {
    it("propagates bounds error for invalid bucket width", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: 0,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-invalid-bucket-width")
      }
    })

    it("propagates bounds error for start >= end", () => {
      const params = {
        start: utc(14),
        end: utc(10),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-start-after-end")
      }
    })

    it("propagates bounds error for invalid interval", () => {
      const params = {
        start: utc(10),
        end: utc(14),
        now: utc(20),
        bucketWidthMillis: 7 * HOUR_MS, // 7 hours doesn't divide evenly into 24
      }
      const earliestDataInDb = Some(utc(8))

      const result = findEffectiveSearchRange(params)(earliestDataInDb)

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-invalid-interval")
      }
    })

    it("does not call bounds validation when earliest is None", () => {
      // Even with invalid params, if there's no data, we return no-data-in-db
      const params = {
        start: utc(14),  // invalid: start > end
        end: utc(10),
        now: utc(20),
        bucketWidthMillis: HOUR_MS,
      }

      const result = findEffectiveSearchRange(params)(None)

      // Should return no-data-in-db without checking bounds
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.type).toBe("no-data-in-db")
      }
    })
  })
})
