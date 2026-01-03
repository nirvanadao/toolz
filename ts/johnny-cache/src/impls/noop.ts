import { ICache, None, Option, SuperJSONSerializable } from "../icache"

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
