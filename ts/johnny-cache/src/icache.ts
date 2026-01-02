import { None, Option } from "ts-results"
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
}

export class NoopCache implements ICache {
  async get<T>(_key: string, _maxStaleSeconds?: number): Promise<Option<T>> {
    return None
  }
  async set<T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> {
    return
  }
  async delete(_key: string): Promise<void> {
    return
  }
  async zadd<T>(_key: string, _members: Array<{ score: number; value: SuperJSONSerializable<T> }>): Promise<number> {
    return 0
  }
  async zrange<T>(
    _key: string,
    _min: number,
    _max: number,
    _opts?: { order?: "asc" | "desc"; limit?: number },
  ): Promise<T[]> {
    return []
  }
  async zremRangeByScore(_key: string, _min: number, _max: number): Promise<number> {
    return 0
  }
}
