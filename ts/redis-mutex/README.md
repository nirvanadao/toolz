# @nirvana-tools/redis-mutex

Dead-simple Redis mutex for deduplicating pubsub messages across concurrent service instances.

## Install

```bash
pnpm add @nirvana-tools/redis-mutex
```

## Usage

```typescript
import { RedisMutex } from "@nirvana-tools/redis-mutex"

const mutex = new RedisMutex({
  url: "redis://localhost:6379",
  keyPrefix: "pubsub-dedup",
  ttlSeconds: 30, // optional, defaults to 30
  onError: (operation, context, error) => {
    console.error(`Mutex ${operation} failed`, context, error)
  },
})

async function handlePubsubMessage(messageId: string, payload: unknown) {
  const token = await mutex.claimMutex(messageId)
  if (!token) {
    // Another instance is already processing this message, skip it
    return
  }

  try {
    // Process the message...
  } finally {
    await mutex.releaseMutex(messageId, token)
  }
}
```

## API

### `claimMutex(key: string): Promise<MutexToken | null>`

Atomically claim a mutex. Returns a token if successful, `null` if already claimed or on error.

### `releaseMutex(key: string, token: MutexToken): Promise<boolean>`

Release a mutex. Only succeeds if you own it (token matches). Returns `false` if already expired or on error.

### `checkMutex(key: string): Promise<boolean>`

Check if a mutex is held. Returns `true` if claimed, `false` if free or on error.

### `disconnect(): Promise<void>`

Gracefully close the Redis connection.

## Safety

- **Atomic claim**: Uses `SET NX EX` - only one process can claim
- **Owner-only release**: Lua script verifies token before delete
- **No deadlocks**: Auto-expires after TTL if client crashes
- **Fail-safe**: `claimMutex` returns `null` on error (won't process if unsure)
