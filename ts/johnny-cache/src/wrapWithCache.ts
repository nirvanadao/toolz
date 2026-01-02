import { Ok, Result, Option, None } from "ts-results"
import { CacheActionId, ICache, SuperJSONSerializable } from "./icache"

/** Worker functions must return a result */
export type WorkerResult<T, E> = Result<SuperJSONSerializable<T>, E>

export type LifecycleCallback = (actionId: CacheActionId) => void

/** Arguments to wrap async worker function with cache */
export type WrapWithCacheOpArgs<T, E> = {
  /** cache key */
  key: string
  /** max tolerance for stale data */
  maxAgeSeconds?: number
  /** name of the operation */
  opName?: string
  /** worker function */
  fn: () => Promise<WorkerResult<T, E>>
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

export type WrapWithCacheOverrideArgs<T, E> = WrapWithCacheOpArgs<T, E> & {
  inFlight: Map<string, Promise<WorkerResult<T, E>>>
  keyTTLSeconds: number
  maxAgeSeconds: number
  cache: ICache
}

export type CacheWrapperConfig = {
  /** cache instance */
  cache: ICache

  /** default cache retention time for keys */
  defaultKeyTTLSeconds: number

  /** default max tolerance for cache */
  defaultMaxAgeSeconds: number

  defaultOnCacheMiss?: LifecycleCallback
  defaultOnCacheHit?: LifecycleCallback
  defaultOnInflightHit?: LifecycleCallback
  defaultOnDoWork?: LifecycleCallback
}

/** Wraps async worker function with cache */
export class CacheWrapper {
  private readonly cache: ICache
  private readonly defaultKeyTTLSeconds: number
  private readonly defaultMaxAgeSeconds: number
  private readonly inflight: Map<string, Promise<WorkerResult<unknown, unknown>>> = new Map()
  private readonly defaultOnCacheMiss?: LifecycleCallback
  private readonly defaultOnCacheHit?: LifecycleCallback
  private readonly defaultOnInflightHit?: LifecycleCallback
  private readonly defaultOnDoWork?: LifecycleCallback

  constructor(args: CacheWrapperConfig) {
    if (args.defaultKeyTTLSeconds <= 0) {
      throw new Error("defaultKeyTTLSeconds must be greater than 0")
    }

    if (args.defaultMaxAgeSeconds <= 0) {
      throw new Error("defaultMaxAgeSeconds must be greater than 0")
    }

    this.cache = args.cache
    this.defaultKeyTTLSeconds = args.defaultKeyTTLSeconds
    this.defaultMaxAgeSeconds = args.defaultMaxAgeSeconds
    this.defaultOnCacheMiss = args.defaultOnCacheMiss
    this.defaultOnCacheHit = args.defaultOnCacheHit
    this.defaultOnInflightHit = args.defaultOnInflightHit
    this.defaultOnDoWork = args.defaultOnDoWork
  }

  wrapWithCache<T, E>({
    key,
    maxAgeSeconds,
    fn,
    opName,
    keyTTLSeconds,
    onCacheMiss,
    onCacheHit,
    onInflightHit,
    onDoWork,
  }: WrapWithCacheOpArgs<T, E>) {
    keyTTLSeconds = keyTTLSeconds ?? this.defaultKeyTTLSeconds
    maxAgeSeconds = maxAgeSeconds ?? this.defaultMaxAgeSeconds

    if (maxAgeSeconds <= 0) {
      throw new Error("maxAge must be greater than 0")
    }

    if (keyTTLSeconds <= 0) {
      throw new Error("keyTTLSeconds must be greater than 0")
    }

    onCacheMiss = onCacheMiss ?? this.defaultOnCacheMiss
    onCacheHit = onCacheHit ?? this.defaultOnCacheHit
    onInflightHit = onInflightHit ?? this.defaultOnInflightHit
    onDoWork = onDoWork ?? this.defaultOnDoWork

    return wrapWithCache<T, E>({
      key,
      maxAgeSeconds,
      // Cast needed: map is heterogeneous (different T,E per key)
      inFlight: this.inflight as Map<string, Promise<WorkerResult<T, E>>>,
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
export async function wrapWithCache<T, E>({
  key,
  maxAgeSeconds,
  inFlight,
  opName,
  cache,
  keyTTLSeconds,
  fn,
  onCacheMiss,
  onCacheHit,
  onInflightHit,
  onDoWork,
}: WrapWithCacheOverrideArgs<T, E>): Promise<WorkerResult<T, E>> {
  const actionId: CacheActionId = { key, opName }
  const cacheData = await tryCache<SuperJSONSerializable<T>>({
    key,
    maxAgeSeconds,
    cache,
    onCacheMiss,
    onCacheHit,
    opName,
  })
  if (cacheData.some) {
    return Ok(cacheData.unwrap())
  }

  // Check if request is already in flight
  // this prevents "thundering herd" while cache is re-validating
  const existing = inFlight.get(key)
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
  maxAgeSeconds,
  cache,
  onCacheMiss,
  onCacheHit,
}: {
  key: string
  opName?: string
  maxAgeSeconds: number
  cache: ICache
  onCacheMiss?: (actionId: CacheActionId) => void
  onCacheHit?: (actionId: CacheActionId) => void
}): Promise<Option<T>> {
  const actionId: CacheActionId = { key, opName }
  const cacheData = await cache.get<T>(key, maxAgeSeconds)

  // not in cache, return None
  if (cacheData.none) {
    onCacheMiss?.(actionId)
    return None
  }

  // else we have something
  onCacheHit?.(actionId)
  return cacheData
}
