import { Option } from "ts-results"
export { None, Option, Some } from "ts-results"

// Primitives that superjson supports
type SerPrimitive = string | number | boolean | null | bigint | Date | RegExp | Error | URL | undefined

// 2. Define the Recursive Validator (Mapped Type)
// If T is valid, it resolves to T. If T contains a function, that part resolves to never.
export type SuperJSONSerializable<T> = T extends SerPrimitive
  ? T
  : T extends Function
  ? never // ⛔️ Rejects functions
  : T extends Promise<any>
  ? never // ⛔️ Rejects Promises
  : T extends (infer U)[]
  ? SuperJSONSerializable<U>[] // Arrays
  : T extends Map<infer K, infer V>
  ? Map<SuperJSONSerializable<K>, SuperJSONSerializable<V>> // Maps
  : T extends Set<infer S>
  ? Set<SuperJSONSerializable<S>> // Sets
  : T extends object
  ? { [K in keyof T]: SuperJSONSerializable<T[K]> } // Objects/Interfaces
  : never

export type CacheActionId = {
  key: string
  /** optional "tag" for operation groups */
  opName?: string
}

export type CacheOpCode = "get" | "set" | "delete" | "zadd" | "zrange" | "zremRangeByScore"

export type OnCacheErrorCallback = (cacheOpCode: CacheOpCode, actionId: CacheActionId, error: unknown) => void

export interface ICache {
  /** Retrieves a string and JSON-parses it into the given type */
  get<T>(key: string, maxStaleSeconds?: number): Promise<Option<T>>

  /** Takes in a JSON-serializable value and sets it in the cache with the given TTL as a string */
  set<T>(key: string, value: SuperJSONSerializable<T>, ttlSeconds?: number): Promise<void>

  delete(key: string): Promise<void>

  /** Adds members with scores to a sorted set */
  zadd<T>(key: string, members: Array<{ score: number; value: SuperJSONSerializable<T> }>): Promise<number>
  /** Gets members by score range (inclusive) */
  zrange<T>(key: string, min: number, max: number, opts?: { order?: "asc" | "desc"; limit?: number }): Promise<T[]>
  /** Removes members with scores in the given range (inclusive) */
  zremRangeByScore(key: string, min: number, max: number): Promise<number>

  onError?: OnCacheErrorCallback
}
