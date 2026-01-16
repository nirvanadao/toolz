# @nirvana-tools/webcache

Drop-in SWR cache for serverless Cloud Run web servers that fetch and show data.

## Features

- **Stale-While-Revalidate (SWR)** - Serve stale data instantly, refresh in background
- **Fail-Safe** - Redis down? Log a warning, fetch fresh, keep serving users
- **Request Coalescing** - 10 concurrent requests = 1 actual fetch
- **Distributed Locks** - Prevent cross-instance cache stampede
- **Result-Based API** - Errors don't get cached, type-safe with `ts-results`
- **Metrics Hooks** - Observability callbacks for hit/miss/swr events

## Installation

```bash
pnpm add @nirvana-tools/webcache
```

## Quick Start

```typescript
import { WebCache, redisDriver } from "@nirvana-tools/webcache"
import { Ok, Err } from "ts-results"

// Create serverless-optimized Redis instance
const redis = redisDriver.createServerlessRedisInstance(process.env.REDIS_URL!)
const driver = new redisDriver.RedisCacheDriver(redis)

const cache = new WebCache({
  driver,
  keyPrefix: "myservice:",
})

// Fetch with SWR
const result = await cache.get("user:123", async () => {
  try {
    const user = await fetchUserFromDB(123)
    return Ok(user)
  } catch (e) {
    return Err(e as Error)  // Won't be cached
  }
})

if (result.ok) {
  return result.val
} else {
  return handleError(result.val)
}
```

## Configuration Options

### `cache.get(key, fetcher, options)`

| Option | Default | Description |
|--------|---------|-------------|
| `swrThreshold` | `60_000` (1min) | Age in ms after which to serve stale and refresh in background |
| `ttl` | `300_000` (5min) | Hard expiration - data deleted from cache after this |
| `maxAgeTolerance` | `Infinity` | Maximum acceptable age - older data triggers fresh fetch |

### Example Configurations

```typescript
// Real-time data (prices, scores)
await cache.get("ticker:BTC", fetcher, {
  swrThreshold: 5_000,      // 5s - always show recent data
  ttl: 60_000,              // 1min
  maxAgeTolerance: 30_000,  // 30s - reject very stale prices
})

// Semi-static data (user profiles)
await cache.get("user:123", fetcher, {
  swrThreshold: 60_000,     // 1min
  ttl: 300_000,             // 5min
  maxAgeTolerance: Infinity // Never reject cached data
})

// Static data (configs, feature flags)
await cache.get("config:features", fetcher, {
  swrThreshold: 300_000,    // 5min
  ttl: 3600_000,            // 1hr
})
```

## Cloud Run Setup

### Environment Variables

```bash
REDIS_URL=redis://10.0.0.1:6379  # Memorystore private IP
```

### Memorystore Configuration

1. Create a Memorystore for Redis instance in the same VPC
2. Configure VPC connector for Cloud Run service
3. Use private IP for low latency

```typescript
// Serverless-optimized Redis config (built-in)
const redis = redisDriver.createServerlessRedisInstance(url)
// Sets: maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 2000
```

## Metrics & Observability

```typescript
const cache = new WebCache({
  driver,
  keyPrefix: "myservice:",
  metrics: {
    onHit: (key, ageMs) => {
      console.log(`Cache HIT: ${key} (age: ${ageMs}ms)`)
      metrics.increment("cache.hit")
    },
    onMiss: (key) => {
      console.log(`Cache MISS: ${key}`)
      metrics.increment("cache.miss")
    },
    onStaleRevalidate: (key, ageMs) => {
      console.log(`Cache SWR: ${key} (age: ${ageMs}ms)`)
      metrics.increment("cache.swr")
    },
    onError: (key, error) => {
      console.error(`Cache ERROR: ${key}`, error)
      metrics.increment("cache.error")
    },
  },
})
```

## Error Handling

Fetchers must return `Result<T, E>` from `ts-results`:

```typescript
import { Ok, Err } from "ts-results"

// Errors are NOT cached - next request will retry
const fetcher = async () => {
  try {
    const data = await fetchData()
    return Ok(data)
  } catch (e) {
    return Err(e as Error)
  }
}

const result = await cache.get("key", fetcher)

if (result.ok) {
  // result.val is your data
} else {
  // result.val is your error
}
```

## ZSET Operations

For time-series data like candles or metrics:

```typescript
// Add items with scores (timestamps)
await cache.zAdd("candles:BTC", candle, candle.timestamp)

// Batch add
await cache.zAddMany("candles:BTC", candles, (c) => c.timestamp, 3600_000)

// Query by time range
const recent = await cache.zRange<Candle>("candles:BTC", startTs, endTs)

// Cleanup old data
await cache.zRemRange("candles:BTC", 0, cutoffTs)
```

## Local Development

Use the in-memory driver for testing:

```typescript
import { WebCache, memoryDriver } from "@nirvana-tools/webcache"

const driver = new memoryDriver.MemoryCacheDriver()
const cache = new WebCache({ driver, keyPrefix: "test:" })
```

## API Reference

### WebCache

```typescript
class WebCache {
  constructor(options: WebCacheOptions)

  // Key-Value
  get<T, E>(key: string, fetcher: Fetcher<T, E>, options?: CacheOptions): Promise<Result<T, E>>
  set<T>(key: string, value: T, ttl?: number): Promise<void>
  delete(key: string): Promise<void>

  // Sorted Sets
  zAdd<T>(key: string, item: T, score: number, ttlMs?: number): Promise<void>
  zAddMany<T>(key: string, items: T[], scoreMapper: (item: T) => number, ttlMs?: number): Promise<void>
  zRange<T>(key: string, minScore: number, maxScore: number): Promise<T[]>
  zRemRange(key: string, minScore: number, maxScore: number): Promise<void>

  // Advanced
  coalescer: PromiseCoalescer  // For custom coalescing
}
```

### Types

```typescript
type Fetcher<T, E = Error> = () => Promise<Result<T, E>>

interface CacheOptions {
  swrThreshold?: number
  ttl?: number
  maxAgeTolerance?: number
}

interface CacheMetrics {
  onHit?: (key: string, ageMs: number) => void
  onMiss?: (key: string) => void
  onStaleRevalidate?: (key: string, ageMs: number) => void
  onError?: (key: string, error: unknown) => void
}
```

## License

MIT
