import { describe, it, expect } from "vitest"
import { getBoundsAligned } from "./bounds"

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS

// Helper to create dates at specific times on a fixed day
const utc = (hour: number, minute = 0, second = 0, ms = 0) =>
  new Date(Date.UTC(2024, 0, 15, hour, minute, second, ms))

describe("getBoundsAligned", () => {
  describe("basic alignment", () => {
    it("floors start to bucket boundary", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 30), // 10:30
        end: utc(14, 0),    // 14:00
        now: utc(16, 0),    // 16:00 (in the past)
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(10, 0).getTime())
      }
    })

    it("returns start unchanged when already on boundary", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0), // exactly 10:00
        end: utc(14, 0),
        now: utc(16, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(10, 0).getTime())
      }
    })

    it("floors end to bucket boundary when end is in the past", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0),
        end: utc(14, 30),  // 14:30
        now: utc(16, 0),   // past
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // 14:30 floors to 14:00
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(14, 0).getTime())
      }
    })
  })

  describe("clamping to now", () => {
    it("clamps end to now when end is in the future", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0),
        end: utc(18, 0),   // future
        now: utc(14, 30),  // 14:30
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // end clamped to 14:30, then floored to 14:00
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(14, 0).getTime())
      }
    })

    it("uses end when end equals now", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0),
        end: utc(14, 0),   // exactly equals now
        now: utc(14, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(14, 0).getTime())
      }
    })

    it("handles now exactly on hour boundary", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0),
        end: utc(15, 0),
        now: utc(14, 0),   // exactly 14:00
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // end clamped to 14:00 (now), floors to 14:00
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(14, 0).getTime())
      }
    })
  })

  describe("different bucket widths", () => {
    it("works with 15 minute buckets", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: 15 * MINUTE_MS,
        start: utc(10, 7),  // 10:07
        end: utc(11, 22),   // 11:22
        now: utc(14, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(10, 0).getTime())
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(11, 15).getTime())
      }
    })

    it("works with 4 hour buckets", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: 4 * HOUR_MS,
        start: utc(9, 0),   // 09:00
        end: utc(15, 0),    // 15:00
        now: utc(20, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // 09:00 floors to 08:00 (4-hour boundary)
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(8, 0).getTime())
        // 15:00 floors to 12:00 (4-hour boundary)
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(12, 0).getTime())
      }
    })
  })

  describe("edge cases", () => {
    it("handles single bucket range", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 15),
        end: utc(10, 45),
        now: utc(14, 0),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        // Both floor to 10:00
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(10, 0).getTime())
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(utc(10, 0).getTime())
      }
    })

    it("handles range spanning midnight", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(22, 30),  // 22:30
        end: new Date(Date.UTC(2024, 0, 16, 2, 30)), // 02:30 next day
        now: new Date(Date.UTC(2024, 0, 16, 10, 0)),
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.startOfFirstBucket.getTime()).toBe(utc(22, 0).getTime())
        expect(result.val.endOfLastClosedBucket.getTime()).toBe(
          new Date(Date.UTC(2024, 0, 16, 2, 0)).getTime()
        )
      }
    })
  })

  describe("validation errors", () => {
    it("rejects zero bucket width", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: 0,
        start: utc(10, 0),
        end: utc(14, 0),
        now: utc(16, 0),
      })

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-invalid-bucket-width")
      }
    })

    it("rejects negative bucket width", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: -HOUR_MS,
        start: utc(10, 0),
        end: utc(14, 0),
        now: utc(16, 0),
      })

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-invalid-bucket-width")
      }
    })

    it("rejects start >= end", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(14, 0),
        end: utc(10, 0),  // before start
        now: utc(16, 0),
      })

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-start-after-end")
      }
    })

    it("rejects start == end", () => {
      const result = getBoundsAligned({
        bucketWidthMillis: HOUR_MS,
        start: utc(10, 0),
        end: utc(10, 0),  // same as start
        now: utc(16, 0),
      })

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-start-after-end")
      }
    })

    it("propagates invalid interval error from time.ts", () => {
      // 7 hours doesn't divide evenly into 24 hours
      const result = getBoundsAligned({
        bucketWidthMillis: 7 * HOUR_MS,
        start: utc(10, 0),
        end: utc(14, 0),
        now: utc(16, 0),
      })

      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("bounds-invalid-interval")
      }
    })
  })
})

