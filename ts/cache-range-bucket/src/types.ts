import { BoundsError } from "./utils/bounds";

export interface ICache {
    zrange<T>(key: string, start: number, end: number, options?: { order: "asc" | "desc" }): Promise<T[]>
    /** Transactionally replace the range in the zset 
     * 
     * For Redis, internally calls MULTI/EXEC to ensure atomicity
     * For remRangeByScore & ZADD
    */
    zreplaceRange<T>(key: string, start: number, end: number, members: Array<{ score: number; value: T }>): Promise<void>
}

export type InternalBoundsError = {
    type: "range-cached-bounds-error"
    internal: BoundsError
}

export type GetZrangeError = {
    type: "range-cached-zrange-error"
    msg: string
    /** The error from the cache call, with stack trace */
    error: Error
}

export type GetRangeFromDbError = {
    type: "range-cached-get-range-from-db-error"
    msg: string
    /** The error from the database call, with stack trace */
    error: Error
}

export type GetLatestBucketBeforeError = {
    type: "range-cached-get-latest-bucket-before-error"
    msg: string
    /** The error from the database call, with stack trace */
    error: Error
}

export type GetEarliestBucketStartError = {
    type: "range-cached-get-earliest-bucket-start-error"
    msg: string
    /** The error from the database call, with stack trace */
    error: Error
}

/**
 * Error when a seed bucket is needed for gap-filling but getLatestBucketBefore() returned null.
 * This is a logical error (no prior bucket exists), not an exception.
 */
export type MissingSeedBucketError = {
    type: "range-cached-missing-seed-bucket-error"
    msg: string
}

export type RangeCachedError =
    | InternalBoundsError
    | GetZrangeError
    | GetRangeFromDbError
    | GetLatestBucketBeforeError
    | GetEarliestBucketStartError
    | MissingSeedBucketError


/** Error factories for RangeCached errors */
export const RangeCachedErrors = {
    InternalBoundsError: (e: BoundsError): RangeCachedError => ({ type: "range-cached-bounds-error", internal: e }),
    GetZrangeError: (msg: string, error: Error): RangeCachedError => ({ type: "range-cached-zrange-error", msg, error }),
    GetRangeFromDbError: (msg: string, error: Error): RangeCachedError => ({ type: "range-cached-get-range-from-db-error", msg, error }),
    GetLatestBucketBeforeError: (msg: string, error: Error): RangeCachedError => ({ type: "range-cached-get-latest-bucket-before-error", msg, error }),
    GetEarliestBucketStartError: (msg: string, error: Error): RangeCachedError => ({ type: "range-cached-get-earliest-bucket-start-error", msg, error }),
    /** Logical error: seed bucket needed but getLatestBucketBefore() returned null */
    MissingSeedBucketError: (msg: string): RangeCachedError => ({ type: "range-cached-missing-seed-bucket-error", msg }),
}
