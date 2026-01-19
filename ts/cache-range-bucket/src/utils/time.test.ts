import { describe, it, expect } from "vitest"
import { floorToInterval } from "./time"

// Constants matching the module
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// Helper to create dates at specific times on a fixed day
const utc = (hour: number, minute = 0, second = 0, ms = 0) =>
  new Date(Date.UTC(2024, 0, 15, hour, minute, second, ms))

describe("floorToInterval", () => {
  describe("valid intervals", () => {
    it("floors to 1 minute boundary", () => {
      const result = floorToInterval(utc(10, 30, 45, 500), MINUTE_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(10, 30, 0, 0).getTime())
      }
    })

    it("floors to 5 minute boundary", () => {
      const result = floorToInterval(utc(10, 37, 0), 5 * MINUTE_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(10, 35, 0).getTime())
      }
    })

    it("floors to 15 minute boundary", () => {
      const result = floorToInterval(utc(10, 47, 30), 15 * MINUTE_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(10, 45, 0).getTime())
      }
    })

    it("floors to 1 hour boundary", () => {
      const result = floorToInterval(utc(10, 30, 0), HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(10, 0, 0).getTime())
      }
    })

    it("floors to 4 hour boundary", () => {
      const result = floorToInterval(utc(10, 30, 0), 4 * HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(8, 0, 0).getTime())
      }
    })

    it("floors to 12 hour boundary", () => {
      const result = floorToInterval(utc(14, 30, 0), 12 * HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(12, 0, 0).getTime())
      }
    })

    it("floors to 24 hour (1 day) boundary", () => {
      const result = floorToInterval(utc(14, 30, 0), DAY_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(0, 0, 0).getTime())
      }
    })

    it("returns same time when already on boundary", () => {
      const exactHour = utc(10, 0, 0, 0)
      const result = floorToInterval(exactHour, HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(exactHour.getTime())
      }
    })

    it("handles midnight correctly", () => {
      const midnight = utc(0, 0, 0, 0)
      const result = floorToInterval(midnight, HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(midnight.getTime())
      }
    })

    it("handles time just before midnight", () => {
      const result = floorToInterval(utc(23, 59, 59, 999), HOUR_MS)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.val.getTime()).toBe(utc(23, 0, 0).getTime())
      }
    })
  })

  describe("invalid intervals", () => {
    it("rejects interval less than 1 minute", () => {
      const result = floorToInterval(utc(10, 30), 30 * 1000) // 30 seconds
      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("invalid-interval")
        expect(result.val.message).toContain("greater than")
      }
    })

    it("rejects interval greater than 1 day", () => {
      const result = floorToInterval(utc(10, 30), 2 * DAY_MS)
      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("invalid-interval")
        expect(result.val.message).toContain("less than")
      }
    })

    it("rejects interval that doesn't divide evenly into 1 day", () => {
      // 7 hours doesn't divide evenly into 24 hours
      const result = floorToInterval(utc(10, 30), 7 * HOUR_MS)
      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("invalid-interval")
        expect(result.val.message).toContain("divisor")
      }
    })

    it("rejects 7 minutes (doesn't divide evenly into 24 hours)", () => {
      // 1440 minutes / 7 = 205.71... (not even)
      const result = floorToInterval(utc(10, 30), 7 * MINUTE_MS)
      expect(result.err).toBe(true)
      if (result.err) {
        expect(result.val.type).toBe("invalid-interval")
      }
    })

    it("rejects zero interval", () => {
      const result = floorToInterval(utc(10, 30), 0)
      expect(result.err).toBe(true)
    })

    it("rejects negative interval", () => {
      const result = floorToInterval(utc(10, 30), -HOUR_MS)
      expect(result.err).toBe(true)
    })
  })
})


