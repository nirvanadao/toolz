# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

This is a pnpm monorepo with packages in `ts/`. Build individual packages:

```bash
cd ts/rpc-pooler && pnpm build      # tsc --build
cd ts/johnny-cache && pnpm build    # tsc --build
cd ts/range-cache && pnpm build     # tsc --build
cd ts/rust-decimal && pnpm build    # tsc --build
```

## Test Commands

```bash
cd ts/range-cache && pnpm test      # vitest run (or `pnpm test:watch` for watch mode)
cd ts/rust-decimal && pnpm test     # jest
```

Only range-cache and rust-decimal have tests. Range-cache uses Vitest, rust-decimal uses Jest.

## Architecture

**Toolz** is a collection of TypeScript utilities for Solana blockchain development, focused on resilience and caching.

### Packages

**rpc-pooler** (`@nirvana-tools/rpc-pooler`)
- Resilient Solana RPC connection management with automatic failover
- `ExponentialBackoffRpcPool`: Retry with exponential backoff and jitter
- `SimpleRpcPool`: Fast failover (one attempt per URL)
- `PoolConnectionProvider`: Wraps pool as standard Solana Connection interface
- `NoRetryError`: Signal permanent failures that shouldn't be retried

**johnny-cache** (`@nirvana-tools/johnny-cache`)
- Generic caching abstraction with Redis and no-op implementations
- `ICache`: Interface for cache operations including ZSET methods (zadd, zrange, zremRangeByScore)
- `CacheWrapper`: Wraps async functions with caching and in-flight deduplication
- `RedisCache`: Full Redis implementation with exponential backoff reconnection
- Uses envelope-based storage separating data from metadata

**range-cache** (`@nirvana-tools/range-cache`)
- Time-series ZSET-based caching for bucketed data (candles, hourly metrics)
- Caches closed historical buckets, fetches open/current bucket fresh
- Handles gap filling for sparse data
- Validates cache completeness by expected bucket count

**rust-decimal** (`@nirvana-tools/rust-decimal`)
- Serialize/deserialize Rust `Decimal` (128-bit fixed-point) to/from JavaScript
- Converts between Decimal.js, floats, strings, and Anchor-serialized formats

### Key Patterns

- **Error handling**: Uses `Result<T, E>` and `Option<T>` from ts-results (functional style)
- **Serialization safety**: `SuperJSONSerializable<T>` type constraint ensures data is JSON-serializable at compile time
- **In-flight deduplication**: CacheWrapper prevents duplicate concurrent requests for the same key

### Tech Stack

- TypeScript 5.4/5.5 (strict mode, CommonJS output, ES2022 target)
- pnpm workspaces with composite TypeScript project references
- Solana web3.js 1.98.0
- Redis 4.7.1 with SuperJSON serialization
- Changesets for versioning
