import { Redis } from "ioredis"
import { CacheDriver } from "./driver"

export class RedisCacheDriver implements CacheDriver {
  constructor(private redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key)
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (ttlMs === Infinity) {
      await this.redis.set(key, value)
    } else {
      await this.redis.set(key, value, "PX", ttlMs)
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    await this.redis.pexpire(key, ttlMs)
  }

  async acquireLock(key: string, value: string, ttlMs: number): Promise<boolean> {
    // 'NX' = Only set if Not Exists
    const result = await this.redis.set(key, value, "PX", ttlMs, "NX")
    return result === "OK"
  }

  async zAdd(key: string, score: number, value: string): Promise<void> {
    await this.redis.zadd(key, score, value)
  }

  async zAddMany(key: string, items: { score: number; value: string }[]): Promise<void> {
    if (items.length === 0) return
    const args: (string | number)[] = []
    for (const item of items) {
      args.push(item.score, item.value)
    }
    await this.redis.zadd(key, ...args)
  }

  async zRangeByScore(key: string, min: number, max: number): Promise<string[]> {
    return this.redis.zrangebyscore(key, min, max)
  }

  async zRemRangeByScore(key: string, min: number, max: number): Promise<void> {
    await this.redis.zremrangebyscore(key, min, max)
  }
}
