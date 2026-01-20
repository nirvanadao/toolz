import { Redis } from "ioredis"
import { CacheDriver } from "./driver"

/** Sane defaults for Cloud Run resilience */
export function createServerlessRedisInstance(url: string): Redis {
  // Configure specifically for Cloud Run resilience
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1, // Fail fast, so can skip to DB
    enableOfflineQueue: false, // Don't hang if Redis is down
    connectTimeout: 2000,
  })

  return redis
}

export class RedisCacheDriver implements CacheDriver {
  constructor(private redis: Redis) { }

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

  async zRangeByScore(key: string, min: number, max: number, options?: { order: "asc" | "desc" }): Promise<string[]> {
    if (options?.order === "desc") {
      return this.redis.zrangebyscore(key, max, min)
    }

    return this.redis.zrangebyscore(key, min, max)
  }

  async zRemRangeByScore(key: string, min: number, max: number): Promise<void> {
    await this.redis.zremrangebyscore(key, min, max)
  }

  async zreplaceRange(key: string, members: { score: number; value: string }[]): Promise<void> {
    if (members.length === 0) return

    // Find min/max scores from the members
    let minScore = members[0].score
    let maxScore = members[0].score
    for (const member of members) {
      if (member.score < minScore) minScore = member.score
      if (member.score > maxScore) maxScore = member.score
    }

    // Build args for ZADD: score1, value1, score2, value2, ...
    const zaddArgs: (string | number)[] = []
    for (const member of members) {
      zaddArgs.push(member.score, member.value)
    }

    // Use a transaction to atomically remove the range and add new members
    await this.redis
      .multi()
      .zremrangebyscore(key, minScore, maxScore)
      .zadd(key, ...zaddArgs)
      .exec()
  }
}
