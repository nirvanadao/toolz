export interface ICache {
    zrange<T>(key: string, start: number, end: number, options?: { order: "asc" | "desc" }): Promise<T[]>
    /** Transactionally replace the range in the zset 
     * 
     * For Redis, internally calls MULTI/EXEC to ensure atomicity
     * For remRangeByScore & ZADD
    */
    zreplaceRange<T>(key: string, start: number, end: number, members: Array<{ score: number; value: T }>): Promise<number>
}