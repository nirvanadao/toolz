# @nvana-dharma/rpc-pooler

A resilient RPC connection pooler for Solana that automatically retries failed requests across multiple RPC endpoints.

**Why use this?** Solana RPC nodes can be unreliable. This package automatically retries your requests across multiple endpoints with configurable retry strategies, so you don't have to handle failover logic yourself.

## Installation

```bash
pnpm add @nvana-dharma/rpc-pooler
```

## Quick Start

The easiest way to use the pooler is with `PoolConnectionProvider`, which implements common Solana Connection methods with automatic failover:

```typescript
import { PoolConnectionProvider } from '@nvana-dharma/rpc-pooler'
import { ExponentialBackoffRpcPool } from '@nvana-dharma/rpc-pooler'
import { PublicKey } from '@solana/web3.js'

// Create a pool with your RPC endpoints
const pool = new ExponentialBackoffRpcPool({
  urls: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://rpc.ankr.com/solana'
  ],
  maxRetries: 3,
  requestTimeoutMs: 5000
})

// Wrap it in a connection provider
const connection = new PoolConnectionProvider(pool)

// Use it like a regular Solana Connection
const accountInfo = await connection.getAccountInfo(
  new PublicKey('...')
)

const blockHeight = await connection.getBlockHeight('finalized')

const { blockhash } = await connection.getLatestBlockhash()
```

That's it! All your RPC calls now automatically retry across multiple endpoints if one fails.

## Supported Methods

`PoolConnectionProvider` implements these commonly-used Connection methods:

- `getAccountInfo(publicKey, commitmentOrConfig?)`
- `getMultipleAccountsInfo(publicKeys, commitmentOrConfig?)`
- `getBlockHeight(commitment?)`
- `getLatestBlockhash(commitmentOrConfig?)`
- `confirmTransaction(strategy, commitment?)`

Need a method that's not listed? You can use the pool directly (see [Direct Pool Usage](#direct-pool-usage)).

## Configuration

### Basic Options (both pool types)

```typescript
{
  urls: string[]                    // Required: List of RPC endpoints
  defaultCommitment?: Commitment    // Default: 'confirmed'
  requestTimeoutMs?: number         // Default: 30000 (30 seconds)
  onError?: (url, error, attempt) => void    // Called on each failed attempt
  onDebug?: (message) => void       // Debug logging callback
}
```

### Exponential Backoff Options

```typescript
{
  maxRetries?: number        // Default: 3 - How many retry cycles
  baseDelayMs?: number      // Default: 1000 - Starting delay between retries
  maxDelayMs?: number       // Default: 30000 - Maximum delay between retries
  jitter?: boolean          // Default: true - Add randomness to delays
  shuffleOnRetry?: boolean  // Default: false - Randomize URL order on each retry
}
```

## Choosing a Retry Strategy

This package provides two retry strategies:

### SimpleRpcPool - Fast Failover

Tries each URL once in order. Fails fast if all endpoints are down.

**Best for:** Quick failover when you have reliable backup RPCs.

```typescript
import { SimpleRpcPool } from '@nvana-dharma/rpc-pooler'

const pool = new SimpleRpcPool({
  urls: ['primary.rpc.com', 'backup1.rpc.com', 'backup2.rpc.com']
})
```

### ExponentialBackoffRpcPool - Resilient Retry

Cycles through all URLs multiple times with increasing delays. Handles temporary outages and rate limits.

**Best for:** Production environments where reliability is critical.

```typescript
import { ExponentialBackoffRpcPool } from '@nvana-dharma/rpc-pooler'

const pool = new ExponentialBackoffRpcPool({
  urls: ['rpc1.com', 'rpc2.com', 'rpc3.com'],
  maxRetries: 3,
  baseDelayMs: 1000,  // Start with 1 second
  maxDelayMs: 30000,  // Cap at 30 seconds
  jitter: true        // Prevent thundering herd
})
```

## Complete Example

```typescript
import {
  ExponentialBackoffRpcPool,
  PoolConnectionProvider
} from '@nvana-dharma/rpc-pooler'
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'

// Set up the pool
const pool = new ExponentialBackoffRpcPool({
  urls: [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
  ],
  maxRetries: 2,
  requestTimeoutMs: 5000,
  onError: (url, error, attempt) => {
    console.error(`Attempt ${attempt} failed for ${url}:`, error.message)
  }
})

const connection = new PoolConnectionProvider(pool)

// Fetch account balance with automatic retry
async function getBalance(pubkey: PublicKey): Promise<number> {
  const accountInfo = await connection.getAccountInfo(pubkey)
  if (!accountInfo) return 0
  return accountInfo.lamports / LAMPORTS_PER_SOL
}

// Fetch multiple accounts with automatic retry
async function getMultipleBalances(pubkeys: PublicKey[]): Promise<number[]> {
  const accounts = await connection.getMultipleAccountsInfo(pubkeys)
  return accounts.map(acc => acc ? acc.lamports / LAMPORTS_PER_SOL : 0)
}

// Usage
const wallet = new PublicKey('...')
const balance = await getBalance(wallet)
console.log(`Balance: ${balance} SOL`)
```

## Advanced Usage

### Direct Pool Usage

If you need methods not provided by `PoolConnectionProvider`, use the pool directly:

```typescript
import { ExponentialBackoffRpcPool } from '@nvana-dharma/rpc-pooler'

const pool = new ExponentialBackoffRpcPool({ urls: [...] })

// Execute any Connection method
const result = await pool.request((connection) => {
  return connection.getSlot()
})

// Complex multi-step operations
const data = await pool.request(async (connection) => {
  const slot = await connection.getSlot()
  const blockTime = await connection.getBlockTime(slot)
  return { slot, blockTime }
})
```

### Statistics

Monitor pool performance:

```typescript
const stats = pool.getStats()

console.log(`Success rate: ${stats.successfulRequests}/${stats.totalRequests}`)

// Per-URL statistics
Object.entries(stats.urlStats).forEach(([url, urlStats]) => {
  console.log(`${url}:`)
  console.log(`  Success rate: ${urlStats.successes}/${urlStats.attempts}`)
  console.log(`  Avg response time: ${urlStats.averageResponseTime?.toFixed(0)}ms`)
})
```

## Error Handling

The pools automatically retry these errors:
- Network timeouts and connection errors
- HTTP 429 (rate limiting), 502, 503, 504 (server errors)
- RPC internal errors

Non-retryable errors (like invalid parameters) fail immediately.

## Performance Tips

1. **Order URLs by reliability** - Put your most reliable RPC first
2. **Set appropriate timeouts** - Balance between patience and speed (5-10 seconds is usually good)
3. **Monitor statistics** - Use `getStats()` to identify problematic RPCs
4. **Use exponential backoff in production** - Handles transient failures better
5. **Enable jitter** - Prevents all clients from retrying simultaneously

## Legacy API

The original `RpcPooler` class is still available for backward compatibility:

```typescript
import { RpcPooler } from '@nvana-dharma/rpc-pooler'

const pooler = new RpcPooler(['url1', 'url2', 'url3'])
const slot = await pooler.request(
  (connection) => connection.getSlot(),
  'finalized'
)
```

**Note:** New code should use `SimpleRpcPool` or `ExponentialBackoffRpcPool` with `PoolConnectionProvider` instead.

## License

MIT
