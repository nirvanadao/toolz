import { Result, Option, Ok } from "ts-results"
import { Bounds, BoundsError, getBoundsAligned } from "./bounds"

export type EffectiveSearchRange = {
    firstBucketStartInclusive: Date
    lastClosedBucketStartInclusive: Date
    lastClosedBucketEndExclusive: Date
}

export type NoDataInDbResult = {
    type: "no-data-in-db"
}

export type SearchRangeEndsBeforeEarliestResult = {
    type: "search-range-ends-before-earliest"
    earliestDataInDb: Date
}

export type SearchRangeResult = {
    type: "ok"
    range: EffectiveSearchRange
    earliestDataInDb: Date
}

export type EffectiveSearchRangeResult =
    | NoDataInDbResult
    | SearchRangeEndsBeforeEarliestResult
    | SearchRangeResult


export type EffectiveSearchRangeParams = {
    start: Date
    end: Date
    now: Date
    bucketWidthMillis: number
}


export const findEffectiveSearchRange = (
    params: EffectiveSearchRangeParams,
) => (earliestDataInDb: Option<Date>): Result<EffectiveSearchRangeResult, BoundsError> => {
    const earliestCalc = calcSearchRangeFromEarliest(params)
    return earliestDataInDb.map(earliestCalc).unwrapOr(Ok({ type: "no-data-in-db" }))
}


const calcEffectiveSearchStart = (
    earliestDateInDb: Date,
    bucketWidthMillis: number,
) => (
    bounds: Bounds
): Date => {
    const maxTime = Math.max(
        earliestDateInDb.getTime(),
        bounds.startOfFirstBucket.getTime()
    )
    // Floor to bucket boundary in case earliestDateInDb is not bucket-aligned
    const aligned = Math.floor(maxTime / bucketWidthMillis) * bucketWidthMillis
    return new Date(aligned)
}


const calcLastClosedBucketStartInclusive = (bucketWidthMillis: number) => (lastClosedBucketEndExclusive: Date) => {
    return new Date(lastClosedBucketEndExclusive.getTime() - bucketWidthMillis)
}

const calcSearchEndsBeforeEarliest = (lastClosedBucketStartInclusive: Date, effectiveSearchStart: Date): boolean => {
    return effectiveSearchStart.getTime() > lastClosedBucketStartInclusive.getTime()
}


const calcSearchRangeFromEarliest = (
    params: EffectiveSearchRangeParams,
) => (earliestDataInDb: Date): Result<EffectiveSearchRangeResult, BoundsError> => {
    const { start, end, now, bucketWidthMillis } = params

    const bounds = getBoundsAligned({
        bucketWidthMillis,
        start,
        end,
        now,
    })

    // 3. Compute effective search start (max of requested start and earliest data)
    // Floor to bucket boundary to handle cases where earliestDataInDb is not bucket-aligned
    const effectiveSearchStart = bounds.map(calcEffectiveSearchStart(earliestDataInDb, bucketWidthMillis))

    const lastClosedBucketEndExclusive = bounds.map(b => b.endOfLastClosedBucket)
    const lastClosedBucketStartInclusive = lastClosedBucketEndExclusive.map(calcLastClosedBucketStartInclusive(bucketWidthMillis))
    const searchEndsBeforeEarliest = Result.all(effectiveSearchStart, lastClosedBucketStartInclusive).map(([start, lastBucketStart]) => calcSearchEndsBeforeEarliest(lastBucketStart, start))

    const normalResult = Result.all(
        effectiveSearchStart,
        lastClosedBucketStartInclusive,
        lastClosedBucketEndExclusive,
    ).map(([effectiveSearchStart, lastClosedBucketStartInclusive, lastClosedBucketEndExclusive]): SearchRangeResult => ({
        type: "ok", range: { firstBucketStartInclusive: effectiveSearchStart, lastClosedBucketStartInclusive, lastClosedBucketEndExclusive }, earliestDataInDb
    }))

    return Result.all(
        searchEndsBeforeEarliest,
        normalResult,
    ).map(
        ([searchEndsBeforeEarliest, normalResult]) =>
            searchEndsBeforeEarliest ?
                { type: "search-range-ends-before-earliest", earliestDataInDb }
                :
                normalResult
    )
}