export interface ICache {
    zrange<T>(key: string, start: number, end: number, options?: { order: "asc" | "desc" }): Promise<T[]>
    zremRangeByScore(key: string, start: number, end: number): Promise<number>
    zadd<T>(key: string, members: Array<{ score: number; value: T }>): Promise<number>
}