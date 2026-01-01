import { Commitment, GetAccountInfoConfig, GetMultipleAccountsConfig, PublicKey } from "@solana/web3.js"
import { IConnectionProvider } from "./connection"
import { LRUCache } from "lru-cache"

export type CacheKey = {
  commitment: Commitment
  address58: string
}

export interface ICache {
  /** returns null if not in cache (or expired) */
  get(key: CacheKey): Promise<Uint8Array | null>
  set(key: CacheKey, data: Uint8Array | null): Promise<boolean>
}

export type InMemoryCacheOptions = {
  ttlMillis: number
  maxSize?: number
}

/** Drop-in in-memory cache implementation for ICache */
export class InMemoryCache implements ICache {
  private static DEFAULT_MAX_SIZE = 1000
  private lru: LRUCache<string, string>

  private static serialize(data: Uint8Array): string {
    return Buffer.from(data).toString("base64")
  }

  private static deserialize(data: string): Uint8Array {
    return new Uint8Array(Buffer.from(data, "base64"))
  }

  constructor(options: InMemoryCacheOptions) {
    const maxSize = options.maxSize ?? InMemoryCache.DEFAULT_MAX_SIZE
    const ttlMillis = options.ttlMillis
    const lru = new LRUCache<string, string>({
      max: maxSize,
      ttl: ttlMillis,
      allowStale: false,
    })

    this.lru = lru
  }
  private getKeyString(key: CacheKey): string {
    return `cachedAccountFetcher:${key.commitment}-${key.address58}`
  }

  async get(key: CacheKey): Promise<Uint8Array | null> {
    const keyString = this.getKeyString(key)
    const val = this.lru.get(keyString)
    if (!val) return null
    return InMemoryCache.deserialize(val)
  }

  async set(key: CacheKey, data: Uint8Array | null): Promise<boolean> {
    const keyString = this.getKeyString(key)

    if (data === null) {
      this.lru.set(keyString, "")
      return true
    }

    const serialized = InMemoryCache.serialize(data)
    this.lru.set(keyString, serialized)
    return true
  }
}

export type OnCacheSetErrorCallback = <T>(key: CacheKey, errorType: T) => any
export type OnCacheHitCallback = (key: CacheKey) => any
export type OnCacheMissCallback = (key: CacheKey) => any

export type CachedAccountFetcherOptions = {
  cache: ICache
  connection: IConnectionProvider
  onCacheSetError?: OnCacheSetErrorCallback
  onCacheHit?: OnCacheHitCallback
  onCacheMiss?: OnCacheMissCallback
}

const defaultOnCacheSetError: OnCacheSetErrorCallback = (key, e) =>
  console.error(`Error setting cache for ${key.address58} at commitment ${key.commitment}:`, e)

const defaultOnCacheHit: OnCacheHitCallback = (_) => {}
const defaultOnCacheMiss: OnCacheMissCallback = (_) => {}

export class CachedAccountFetcher {
  private readonly singleAccountInflight: Map<string, Promise<Uint8Array | null>>
  private readonly multipleAccountsInflight: Map<string, Promise<(Uint8Array | null)[]>>
  private readonly cache: ICache
  private readonly connection: IConnectionProvider
  private readonly onCacheSetError: OnCacheSetErrorCallback
  private readonly onCacheHit: OnCacheHitCallback
  private readonly onCacheMiss: OnCacheMissCallback

  constructor(options: CachedAccountFetcherOptions) {
    this.cache = options.cache
    this.connection = options.connection
    this.onCacheSetError = options.onCacheSetError || defaultOnCacheSetError
    this.onCacheHit = options.onCacheHit || defaultOnCacheHit
    this.onCacheMiss = options.onCacheMiss || defaultOnCacheMiss
    this.singleAccountInflight = new Map()
    this.multipleAccountsInflight = new Map()
  }

  private get defaultCommitment(): Commitment {
    return this.connection.defaultCommitment
  }

  private _setCache(key: CacheKey, data: Uint8Array | null): void {
    // don't block the main thread on this
    // and don't throw an error if it fails
    this.cache.set(key, data).catch((e: unknown) => {
      this.onCacheSetError(key, e)
    })
  }

  private async _getCache(key: CacheKey): Promise<Uint8Array | null> {
    const cached = await this.cache.get(key)
    if (cached) {
      this.onCacheHit(key)
      return cached
    }
    this.onCacheMiss(key)
    return null
  }

  async getSingleAccount(
    addressBase58: string,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<Uint8Array | null> {
    // get the effective commitment
    const commitmentOverride = commitmentOrConfig
      ? typeof commitmentOrConfig === "string"
        ? commitmentOrConfig
        : commitmentOrConfig.commitment
      : undefined

    const effectiveCommitment = commitmentOverride ?? this.defaultCommitment

    // get the cache key
    const key = { commitment: effectiveCommitment, address58: addressBase58 }
    // check the cache
    const cached = await this._getCache(key)
    if (cached) return cached

    const inflightKey = `get-single-account:${addressBase58}-${effectiveCommitment}`
    const alreadyInFlight = this.singleAccountInflight.get(inflightKey)

    if (alreadyInFlight) {
      return alreadyInFlight
    }

    const promise = this.connection
      .getAccountInfo(new PublicKey(addressBase58), commitmentOrConfig)
      .then((a) => a?.data ?? null)

    this.singleAccountInflight.set(inflightKey, promise)

    try {
      const account = await promise
      this._setCache(key, account)
      return account
    } finally {
      this.singleAccountInflight.delete(inflightKey)
    }
  }

  async getMultipleAccounts(
    addressBase58s: string[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
  ): Promise<(Uint8Array | null)[]> {
    // get the effective commitment
    const commitmentOverride = commitmentOrConfig
      ? typeof commitmentOrConfig === "string"
        ? commitmentOrConfig
        : commitmentOrConfig.commitment
      : undefined

    const effectiveCommitment = commitmentOverride ?? this.defaultCommitment

    const keys = addressBase58s.map((address) => ({ commitment: effectiveCommitment, address58: address }))

    // first check the cache for all the addresses
    const cached = await Promise.all(keys.map((key) => this._getCache(key)))

    // if all the accounts are in the cache, return them
    // why all? because if one is not in the cache, we need to fetch it and it takes the same amount of time to fetch all of them as just 1
    if (cached.every((data) => data !== null)) {
      return cached
    }

    const inflightKey = `get-multiple-accounts:${[...addressBase58s].sort().join("-")}-${effectiveCommitment}`
    const alreadyInFlight = this.multipleAccountsInflight.get(inflightKey)
    if (alreadyInFlight) {
      return alreadyInFlight
    }

    // since it's just 1 RPC call to get all accounts, fetch everything and refresh the cache
    const pks = addressBase58s.map((address) => new PublicKey(address))
    const promise = this.connection
      .getMultipleAccountsInfo(pks, commitmentOrConfig)
      .then((accounts) => accounts.map((a) => a?.data ?? null))

    this.multipleAccountsInflight.set(inflightKey, promise)

    try {
      const accounts = await promise
      // set the cache
      accounts.forEach((a, i) => {
        if (!a) return
        const address = addressBase58s[i]
        const key = { commitment: effectiveCommitment, address58: address }
        this._setCache(key, a)
      })
      return accounts
    } finally {
      this.multipleAccountsInflight.delete(inflightKey)
    }
  }
}
