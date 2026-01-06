# @nvana-dharma/dedup-pubsub-publisher

A Redis-backed publisher wrapper that prevents duplicate messages from being published to Google Cloud Pub/Sub, even with concurrent processes.

## Features

- **Exactly-once delivery**: Prevents duplicate publishes across multiple concurrent processes
- **Fast and simple**: Binary state model (pending/published) with no complex timing logic
- **Automatic cleanup**: Deletes Redis keys on publish failure to allow retries
- **Long TTL support**: Works with hour-long TTLs for reliable deduplication

## Installation

```bash
npm install @nvana-dharma/dedup-pubsub-publisher
```

## Usage

```typescript
import { DedupPubSubPublisher, RedisDedupCache } from "@nvana-dharma/dedup-pubsub-publisher"
import { PubSub } from "@google-cloud/pubsub"

// Create the cache
const cache = new RedisDedupCache({
  redisUrl: "redis://localhost:6379",
  ttlSeconds: 3600, // 1 hour
  keyPrefix: "dedup:",
  logger: logger,
})

// Create your PubSub publisher (implement IPublisher interface)
const pubsubPublisher = new PubSubPublisher({
  projectId: "my-project",
  topicName: "my-topic",
})

// Wrap it with deduplication
const publisher = new DedupPubSubPublisher(pubsubPublisher, cache, logger)

// Connect
await publisher.connect()

// Publish messages
try {
  await publisher.publish(Buffer.from("my message"))
  // Success - message published or was already published
} catch (error) {
  // Publish failed - safe to retry (Redis key was cleaned up)
  console.error("Publish failed:", error)
}

// Get statistics
const stats = publisher.getStats()
console.log(`Published: ${stats.published}, Cached: ${stats.cached}, Failed: ${stats.failed}`)

// Cleanup
await publisher.stop()
```

## How It Works

When you call `publish()`, the library automatically executes a two-phase commit protocol:

### Two-Phase Commit Protocol (Automatic)

1. **Claim**: Atomically set Redis key to `"pending"` state
2. **Publish**: Publish message to Pub/Sub
3. **Confirm**: On success, set Redis key to `"published"` state
4. **Cleanup**: On failure, delete Redis key and throw error

All of this happens internally - you just call `publish()` and the library handles the rest.

### Deduplication Logic

- **Key doesn't exist** → Publish it
- **Key = "published"** → Skip (already done)
- **Key = "pending"** → Skip (another process is handling it)

### Concurrent Process Safety

```
Process A: Set "pending" → Publishing...
Process B: Tries to publish → Sees "pending" → Skips ✓
Process A: Publish succeeds → Set "published"
Process C: Tries to publish → Sees "published" → Skips ✓
```

### Failure Handling

When publish fails (e.g., Pub/Sub API down):
1. Redis key is deleted
2. Error is thrown
3. Caller can safely retry

## API Reference

### `DedupPubSubPublisher`

#### Constructor

```typescript
new DedupPubSubPublisher(
  publisher: IPublisher,
  cache: IDedupCache,
  logger: ILogger
)
```

#### Methods

**`publish(data: Buffer): Promise<void>`**

Publishes a message with deduplication. Throws on failure.

**`connect(): Promise<void>`**

Connects to the cache.

**`stop(): Promise<void>`**

Gracefully stops the publisher and disconnects from cache.

**`getStats(): PublishStats`**

Returns statistics: `{ published, cached, failed }`

**`resetStats(): void`**

Resets statistics counters to zero.

### `RedisDedupCache`

#### Constructor

```typescript
new RedisDedupCache({
  redisUrl: string       // Redis connection URL
  ttlSeconds: number     // TTL for cache entries (e.g., 3600 for 1 hour)
  keyPrefix: string      // Prefix for all Redis keys
  logger: ILogger        // Logger instance
})
```

## Responsibilities

### This Library Handles

✅ Preventing duplicate publishes from concurrent processes
✅ Atomic claim operations (via Redis SETNX)
✅ Cleaning up Redis keys on publish failures

### Caller Handles

📋 Checkpoint/retry logic for process crashes
📋 Ensuring messages don't get lost due to failures
📋 Managing application-level state persistence

## Key Points

- **TTL**: Use a long TTL (e.g., 1 hour) to prevent duplicates across restarts
- **Cache keys**: Based on SHA-256 hash of message content
- **Process crashes**: Caller should use checkpoints to detect and retry stuck messages
- **Pub/Sub assumptions**: If `publish()` doesn't throw, the message landed successfully

## License

MIT
