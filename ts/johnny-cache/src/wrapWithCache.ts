import { Ok, Result, Option, None } from "ts-results"
import { ICache, SuperJSONSerializable } from "./icache"

/** Worker functions must return a result */
export type WorkerResult = Result<SuperJSONSerializable<unknown>, unknown>

export type CacheActionId = {
  key: string
  opName?: string
}

export type LifecycleCallback = (actionId: CacheActionId) => void

/** Arguments for the wrap with cache operation */
export type WrapWithCacheOpArgs = {
  /** cache key */
  key: string
  /** max tolerance for stale data */
  maxAge: number
  /** name of the operation */
  opName?: string
  /** worker function */
  fn: () => Promise<WorkerResult>
  /** override for key ttl */
  keyTTLSeconds?: number
  /** override callback when the cache is missed */
  onCacheMiss?: (actionId: CacheActionId) => void
  /** override callback when the cache is hit */
  onCacheHit?: (actionId: CacheActionId) => void
  /** override callback when the inflight check is hit */
  onInflightHit?: (actionId: CacheActionId) => void
  /** override callback when the work needs to be done */
  onDoWork?: (actionId: CacheActionId) => void
}

export type WrapWithCacheOverrideArgs = WrapWithCacheOpArgs & {
  inFlight: Map<string, Promise<WorkerResult>>
  cache: ICache
}

export type CacheWrapperConfig = {
  /** cache instance */
  cache: ICache
  /** default cache retention time for keys */
  defaultKeyTTLSeconds?: number

  /** default max age for cache */
  defaultMaxAge?: number

  defaultOnCacheMiss?: LifecycleCallback
  defaultOnCacheHit?: LifecycleCallback
  defaultOnInflightHit?: LifecycleCallback
  defaultOnDoWork?: LifecycleCallback
}

export class CacheWrapper {
  private readonly cache: ICache
  private readonly defaultKeyTTLSeconds?: number
  private readonly defaultMaxAge?: number
  private readonly inflight: Map<string, Promise<WorkerResult>> = new Map()
  private readonly defaultOnCacheMiss?: LifecycleCallback
  private readonly defaultOnCacheHit?: LifecycleCallback
  private readonly defaultOnInflightHit?: LifecycleCallback
  private readonly defaultOnDoWork?: LifecycleCallback

  constructor(args: CacheWrapperConfig) {
    this.cache = args.cache
    this.defaultKeyTTLSeconds = args.defaultKeyTTLSeconds
    this.defaultMaxAge = args.defaultMaxAge
    this.defaultOnCacheMiss = args.defaultOnCacheMiss
    this.defaultOnCacheHit = args.defaultOnCacheHit
    this.defaultOnInflightHit = args.defaultOnInflightHit
    this.defaultOnDoWork = args.defaultOnDoWork
  }

  wrapWithCache({
    key,
    maxAge,
    fn,
    opName,
    keyTTLSeconds,
    onCacheMiss,
    onCacheHit,
    onInflightHit,
    onDoWork,
  }: WrapWithCacheOpArgs) {
    keyTTLSeconds = keyTTLSeconds ?? this.defaultKeyTTLSeconds
    maxAge = maxAge ?? this.defaultMaxAge
    onCacheMiss = onCacheMiss ?? this.defaultOnCacheMiss
    onCacheHit = onCacheHit ?? this.defaultOnCacheHit
    onInflightHit = onInflightHit ?? this.defaultOnInflightHit
    onDoWork = onDoWork ?? this.defaultOnDoWork

    return wrapWithCache({
      key,
      maxAge,
      inFlight: this.inflight,
      opName,
      cache: this.cache,
      keyTTLSeconds,
      fn,
      onCacheMiss,
      onCacheHit,
      onInflightHit,
      onDoWork,
    })
  }
}

// exposed, in case clients don't want to use the class
export async function wrapWithCache<T extends SuperJSONSerializable<unknown>, E = unknown>({
  key,
  maxAge,
  inFlight,
  opName,
  cache,
  keyTTLSeconds,
  fn,
  onCacheMiss,
  onCacheHit,
  onInflightHit,
  onDoWork,
}: WrapWithCacheOverrideArgs): Promise<WorkerResult> {
  const actionId: CacheActionId = { key, opName }
  const cacheData = await tryCache<T>({ key, maxAge, cache, onCacheMiss, onCacheHit })
  if (cacheData.some) {
    return Ok(cacheData.unwrap())
  }

  // Check if request is already in flight
  // this prevents "thundering herd" while cache is re-validating
  const existing = inFlight.get(key) as Promise<WorkerResult>
  if (existing) {
    onInflightHit?.(actionId)
    return existing
  }

  // missed the cache
  // and the inflight check
  // doing the work
  onDoWork?.(actionId)

  // Execute and track
  const promise = fn()

  inFlight.set(key, promise)

  try {
    const data = await promise

    // do not set if Error
    if (data.ok) {
      cache.set(key, data.val, keyTTLSeconds)
    }

    // return Result so client can handle Error cases
    return data
  } finally {
    // always delete the in flight promise
    // even if the work throws an exception
    // or if the work returns an Error
    inFlight.delete(key)
  }
}

async function tryCache<T>({
  key,
  opName,
  maxAge,
  cache,
  onCacheMiss,
  onCacheHit,
}: {
  key: string
  opName?: string
  maxAge: number
  cache: ICache
  onCacheMiss?: (actionId: CacheActionId) => void
  onCacheHit?: (actionId: CacheActionId) => void
}): Promise<Option<T>> {
  const actionId: CacheActionId = { key, opName }
  const cacheData = await cache.get<T>(key, maxAge)

  // not in cache, return None
  if (cacheData.none) {
    onCacheMiss?.(actionId)
    return None
  }

  // else we have something
  onCacheHit?.(actionId)
  return cacheData
}
