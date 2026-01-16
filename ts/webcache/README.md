for price data:

A tight SWR, a genereous TTL, and an infinite max age (a user should not block)

```ts
const marketPrices = await cache.get(
  'market:tickers', 
  () => fetchMarketPrices(), 
  {
    swrThreshold: 5_000, // 5s: Freshness target
    ttl: 120_000,         // 2m: Resilience target
    maxAgeTolerance: Infinity // Never block the user
  }
);
```
