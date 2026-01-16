import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { WebCache } from "./webcache"
import { MemoryCacheDriver } from "./memory_driver"
import { CacheDriver } from "./driver"

describe("WebCache", () => {
  let driver: MemoryCacheDriver
  let cache: WebCache

  beforeEach(() => {
    driver = new MemoryCacheDriver()
    cache = new WebCache({
      driver,
      keyPrefix: "test:",
    })
  })

  afterEach(() => {
    driver.clear()
  })

  describe("get() - basic behavior", () => {
    it("should fetch and cache on miss", async () => {
      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return { data: "hello" }
      }

      const result = await cache.get("key1", fetcher)
      expect(result).toEqual({ data: "hello" })
      expect(fetchCount).toBe(1)

      // Second call should use cache
      const result2 = await cache.get("key1", fetcher)
      expect(result2).toEqual({ data: "hello" })
      expect(fetchCount).toBe(1) // No additional fetch
    })

    it("should return fresh data without revalidation within SWR threshold", async () => {
      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return "value"
      }

      // First fetch
      await cache.get("key", fetcher, { swrThreshold: 60_000 })
      expect(fetchCount).toBe(1)

      // Immediate second call - should be fresh (no revalidation)
      await cache.get("key", fetcher, { swrThreshold: 60_000 })
      expect(fetchCount).toBe(1)
    })
  })

  describe("get() - SWR behavior", () => {
    it("should trigger background revalidation when past SWR threshold", async () => {
      // Use real timers with short SWR threshold
      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return `value-${fetchCount}`
      }

      // Initial fetch
      const result1 = await cache.get("swr-key", fetcher, { swrThreshold: 10, ttl: 10_000 })
      expect(result1).toBe("value-1")
      expect(fetchCount).toBe(1)

      // Wait past SWR threshold
      await new Promise((r) => setTimeout(r, 20))

      // This should return stale value AND trigger background refresh
      const result2 = await cache.get("swr-key", fetcher, { swrThreshold: 10, ttl: 10_000 })
      expect(result2).toBe("value-1") // Returns stale immediately

      // Wait for background refresh to complete
      await new Promise((r) => setTimeout(r, 20))

      // Background refresh should have happened
      expect(fetchCount).toBe(2)

      // Value should now be updated
      const result3 = await cache.get("swr-key", fetcher, { swrThreshold: 10_000, ttl: 10_000 })
      expect(result3).toBe("value-2")
    })

    it("should fetch fresh when age exceeds maxAgeTolerance", async () => {
      vi.useFakeTimers()

      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        return `value-${fetchCount}`
      }

      // Initial fetch
      await cache.get("key", fetcher, { maxAgeTolerance: 100, ttl: 10_000 })
      expect(fetchCount).toBe(1)

      // Advance past tolerance
      vi.advanceTimersByTime(150)

      // Should fetch fresh (not return stale)
      const result = await cache.get("key", fetcher, { maxAgeTolerance: 100, ttl: 10_000 })
      expect(result).toBe("value-2")
      expect(fetchCount).toBe(2)

      vi.useRealTimers()
    })
  })

  describe("request coalescing", () => {
    it("should coalesce concurrent requests for the same key", async () => {
      let fetchCount = 0
      const fetcher = async () => {
        fetchCount++
        await new Promise((r) => setTimeout(r, 10))
        return "value"
      }

      // Fire multiple concurrent requests
      const promises = [
        cache.get("key", fetcher),
        cache.get("key", fetcher),
        cache.get("key", fetcher),
      ]

      const results = await Promise.all(promises)

      expect(results).toEqual(["value", "value", "value"])
      expect(fetchCount).toBe(1) // Only one actual fetch
    })
  })

  describe("set() and delete()", () => {
    it("should allow explicit set", async () => {
      await cache.set("explicit", { value: 42 })

      let fetched = false
      const result = await cache.get("explicit", async () => {
        fetched = true
        return { value: 0 }
      })

      expect(result).toEqual({ value: 42 })
      expect(fetched).toBe(false)
    })

    it("should allow delete", async () => {
      await cache.set("to-delete", "value")
      await cache.delete("to-delete")

      let fetchCount = 0
      await cache.get("to-delete", async () => {
        fetchCount++
        return "fresh"
      })

      expect(fetchCount).toBe(1)
    })
  })

  describe("fail-safe behavior", () => {
    it("should treat driver errors as cache miss", async () => {
      const failingDriver: CacheDriver = {
        get: async () => {
          throw new Error("Connection refused")
        },
        set: async () => {},
        del: async () => {},
        expire: async () => {},
        acquireLock: async () => false,
        zAdd: async () => {},
        zAddMany: async () => {},
        zRangeByScore: async () => [],
        zRemRangeByScore: async () => {},
      }

      const failCache = new WebCache({
        driver: failingDriver,
        keyPrefix: "fail:",
      })

      let fetchCount = 0
      const result = await failCache.get("key", async () => {
        fetchCount++
        return "fresh-value"
      })

      expect(result).toBe("fresh-value")
      expect(fetchCount).toBe(1)
    })

    it("should handle corrupt cache data gracefully", async () => {
      // Manually insert corrupt data
      await driver.set("test:corrupt", "not-valid-json{{{", 60_000)

      let fetchCount = 0
      const result = await cache.get("corrupt", async () => {
        fetchCount++
        return "fresh"
      })

      expect(result).toBe("fresh")
      expect(fetchCount).toBe(1)
    })
  })

  describe("ZSET operations", () => {
    it("should add and query by score range", async () => {
      await cache.zAdd("scores", { id: 1, name: "first" }, 100)
      await cache.zAdd("scores", { id: 2, name: "second" }, 200)
      await cache.zAdd("scores", { id: 3, name: "third" }, 300)

      const range = await cache.zRange<{ id: number; name: string }>("scores", 100, 200)
      expect(range).toHaveLength(2)
      expect(range[0].id).toBe(1)
      expect(range[1].id).toBe(2)
    })

    it("should batch add items", async () => {
      const items = [
        { ts: 1000, value: "a" },
        { ts: 2000, value: "b" },
        { ts: 3000, value: "c" },
      ]

      await cache.zAddMany("timeseries", items, (item) => item.ts)

      const all = await cache.zRange<{ ts: number; value: string }>("timeseries", 0, Infinity)
      expect(all).toHaveLength(3)
    })

    it("should remove by score range", async () => {
      await cache.zAdd("cleanup", "old", 100)
      await cache.zAdd("cleanup", "keep", 200)
      await cache.zAdd("cleanup", "ancient", 50)

      await cache.zRemRange("cleanup", 0, 150)

      const remaining = await cache.zRange<string>("cleanup", 0, Infinity)
      expect(remaining).toEqual(["keep"])
    })
  })
})

describe("MemoryCacheDriver", () => {
  let driver: MemoryCacheDriver

  beforeEach(() => {
    driver = new MemoryCacheDriver()
  })

  it("should expire keys after TTL", async () => {
    vi.useFakeTimers()

    await driver.set("key", "value", 100)
    expect(await driver.get("key")).toBe("value")

    vi.advanceTimersByTime(150)
    expect(await driver.get("key")).toBeNull()

    vi.useRealTimers()
  })

  it("should handle infinite TTL", async () => {
    await driver.set("eternal", "value", Infinity)
    expect(await driver.get("eternal")).toBe("value")
  })

  it("should acquire and release locks", async () => {
    const acquired1 = await driver.acquireLock("lock:test", "token1", 1000)
    expect(acquired1).toBe(true)

    // Second attempt should fail
    const acquired2 = await driver.acquireLock("lock:test", "token2", 1000)
    expect(acquired2).toBe(false)

    // After delete, should be acquirable again
    await driver.del("lock:test")
    const acquired3 = await driver.acquireLock("lock:test", "token3", 1000)
    expect(acquired3).toBe(true)
  })

  it("should update expire time", async () => {
    vi.useFakeTimers()

    await driver.set("key", "value", 100)
    await driver.expire("key", 200)

    vi.advanceTimersByTime(150)
    expect(await driver.get("key")).toBe("value") // Still alive

    vi.advanceTimersByTime(100)
    expect(await driver.get("key")).toBeNull() // Now expired

    vi.useRealTimers()
  })
})
