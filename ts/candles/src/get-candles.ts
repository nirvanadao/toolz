import { Err, None, Ok, Option, Result, Some } from "ts-results"
import { Candle, CandleData, ICache } from "./types"
import { getBucketsInRange, bounds, RangeCachedError, RangeResult } from "@nirvana-tools/cache-range-buckets"
import { AsyncResultWrapper, AsyncOk } from 'ts-async-results'

/** Return Some(date) if there is data, None if there is no data at all */
export type GetEarliestPriceDate = () => Promise<Option<Date>>

/** Return Some(candle) if there is data, None if there is no data at all */
export type GetLatestCandleBefore = (date: Date) => Promise<Option<Candle>>

export type GetCandlesInRange = (startInclusive: Date, endExclusive: Date) => Promise<Candle[]>

export type GetOpenCandle = () => Promise<Option<Candle>>

export type GetCandlesParams<EntityKey> = {
    /** namespace for the cache key */
    cacheKeyNamespace: string

    /** inclusive start */
    start: Date

    /** inclusive end */
    end: Date

    /** width of the buckets in milliseconds */
    bucketWidthMillis: number

    /** probably a string */
    entityKey: EntityKey

    /** get the earliest bucket for the entity from the database */
    getEarliestPriceDate: GetEarliestPriceDate

    getLatestCandleBefore: GetLatestCandleBefore

    /** get the buckets in range for the entity */
    getCandlesInRange: GetCandlesInRange

    getOpenCandle: GetOpenCandle

    cache: ICache

    /** Must provide current time, so that the open bucket can be determined */
    now: Date
}

export const INTERNAL_RANGE_CACHE_ERROR_TYPE = "internal-range-cache-error" as const
export const INTERNAL_BOUNDS_ERROR_TYPE = "internal-bounds-error" as const

export type GetCandlesError =
    | { type: typeof INTERNAL_RANGE_CACHE_ERROR_TYPE; inner: RangeCachedError }
    | { type: typeof INTERNAL_BOUNDS_ERROR_TYPE; inner: bounds.BoundsError }

export type RangeStatus =
    | { type: "ok" }
    | { type: "range-before-earliest"; earliest: Date }
    | { type: "no-data-at-all" }

export type CandlesResponse = {
    historyAscending: Candle[]
    openCandle: Option<Candle>
    status: RangeStatus
}

export async function getCandlesInRange<EntityKey>(params: GetCandlesParams<EntityKey>): Promise<Result<CandlesResponse, GetCandlesError>> {
    const { start, end, bucketWidthMillis, entityKey, getEarliestPriceDate, getLatestCandleBefore, getCandlesInRange, cache, now } = params
    const candleGapConstructor = gapFillConstructor(bucketWidthMillis)

    const openCandleP = fetchOpenCandle({
        getOpenCandle: params.getOpenCandle,
        bucketWidthMillis,
        start,
        end,
        now,
    })

    const closedCandlesP = getBucketsInRange<EntityKey, Candle>({
        cacheKeyNamespace: params.cacheKeyNamespace,
        start,
        end,
        bucketWidthMillis,
        entityKey,
        getEarliestBucketStart: () => getEarliestPriceDate().then(o => o.unwrapOr(null)),
        getLatestBucketBefore: (d) => getLatestCandleBefore(d).then(o => o.unwrapOr(null)),
        getBucketsInRange: getCandlesInRange,
        gapFillConstructor: candleGapConstructor,
        pluckBucketTimestamp: pluckCandleTimestamp,
        cache,
        now,
    })

    const [closedCandles, openCandleFromDb] = await Promise.all([
        closedCandlesP,
        openCandleP,
    ])

    const closedCandlesStatus = mapClosedCandlesResult(closedCandles)

    const openCandle = Result.all(
        closedCandlesStatus,
        openCandleFromDb,
    ).map(([closedCandlesStatus, openCandleFromDb]) => computeOpenCandle(openCandleFromDb, closedCandlesStatus.historyAscending, bucketWidthMillis))

    return Result.all(closedCandlesStatus, openCandle).map(([closedCandlesStatus, openCandle]) => ({
        historyAscending: closedCandlesStatus.historyAscending,
        status: closedCandlesStatus.status,
        openCandle,
    }))
}


/** Fill empty candles with the previous close price */
export const gapFillConstructor = (bucketWidthMillis: number) => (prev: Candle): Candle => {
    const newTimestampMillis = prev.timestampMillis + bucketWidthMillis
    const prevClose = prev.data.close
    const data: CandleData = {
        open: prevClose,
        high: prevClose,
        low: prevClose,
        close: prevClose,
    }
    return {
        data,
        timestampMillis: newTimestampMillis,
    }
}

export function pluckCandleTimestamp(c: Candle): Date {
    return new Date(c.timestampMillis)
}


export type NeedsOpenCandleParams = {
    now: Date
    desiredSearchEnd: Date
    endOfLastClosedBucket: Date
    bucketWidthMillis: number
}

export function needsOpenCandle(
    params: NeedsOpenCandleParams,
): boolean {
    const { now, desiredSearchEnd, endOfLastClosedBucket, bucketWidthMillis } = params
    const nowT = now.getTime()
    const endOfLastClosedBucketT = endOfLastClosedBucket.getTime()
    const desiredSearchEndT = desiredSearchEnd.getTime()

    return nowT > endOfLastClosedBucketT && nowT < endOfLastClosedBucketT + bucketWidthMillis && desiredSearchEndT > endOfLastClosedBucketT
}


export type ClosedCandlesStatus = {
    historyAscending: Candle[]
    status: RangeStatus
}

export function mapClosedCandlesResult(
    closedCandles: Result<RangeResult<Candle>, RangeCachedError>,
): Result<ClosedCandlesStatus, GetCandlesError> {
    // Handle actual errors (exceptions)
    if (closedCandles.err) {
        return Err({ type: INTERNAL_RANGE_CACHE_ERROR_TYPE, inner: closedCandles.val })
    }

    // Handle the discriminated union result
    const rangeResult = closedCandles.val

    switch (rangeResult.type) {
        case "no-data-at-all":
            return Ok({
                historyAscending: [],
                status: { type: "no-data-at-all" },
            })

        case "search-range-ends-before-earliest":
            return Ok({
                historyAscending: [],
                status: { type: "range-before-earliest", earliest: rangeResult.earliestDataInDb },
            })

        case "ok":
            return Ok({
                historyAscending: rangeResult.buckets,
                status: { type: "ok" },
            })
    }
}

export function computeOpenCandle(
    openCandleFromDb: Option<Candle>,
    historyAscending: Candle[],
    bucketWidthMillis: number,
): Option<Candle> {
    if (openCandleFromDb.some) {
        return Some(openCandleFromDb.val)
    }
    if (historyAscending.length === 0) {
        return None
    }
    const defaultOpen = gapFillConstructor(bucketWidthMillis)(historyAscending[historyAscending.length - 1])
    return Some(defaultOpen)
}

type GetOpenCandleParams = {
    getOpenCandle: GetOpenCandle
    bucketWidthMillis: number
    start: Date
    end: Date
    now: Date
}

async function fetchOpenCandle(params: GetOpenCandleParams): Promise<Result<Option<Candle>, GetCandlesError>> {
    const { bucketWidthMillis, start, end, now } = params
    const searchRange = bounds.getBoundsAligned({
        bucketWidthMillis,
        start,
        end,
        now,
    }).mapErr(mapBoundsError)
    // unwrap value for convenience
    const mustGetOpenCandle = searchRange.map(sr => needsOpenCandle({ now, desiredSearchEnd: end, endOfLastClosedBucket: sr.endOfLastClosedBucket, bucketWidthMillis }))

    const openCandleP = new AsyncResultWrapper(mustGetOpenCandle)
        .flatMap(mustFetch => mustFetch ? new AsyncOk(params.getOpenCandle()) : new AsyncOk(Promise.resolve(None)))

    return openCandleP.resolve()
}


function mapBoundsError(e: bounds.BoundsError): GetCandlesError {
    return { type: 'internal-bounds-error', inner: e }
}
