export type CandleData = {
    open: number
    high: number
    low: number
    close: number
}

export type Candle = {
    data: CandleData
    timestampMillis: number
}

export interface ICache {
    zrange<T>(key: string, start: number, end: number, options?: { order: "asc" | "desc" }): Promise<T[]>
    zremRangeByScore(key: string, start: number, end: number): Promise<number>
    zadd<T>(key: string, members: Array<{ score: number; value: T }>): Promise<number>
}