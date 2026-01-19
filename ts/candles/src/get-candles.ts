import { Err, None, Ok, Option, Result, Some } from "ts-results"
import { Candle, CandleData, ICache } from "./types"
import { getBucketsInRange, bounds, GetBucketsInRangeError } from "@nirvana-tools/cache-range-buckets"

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


/** Fill empty candles with the previous close price */
const gapFillConstructor = (bucketWidthMills: number) => (prev: Candle): Candle => {
    const newTimestampMillis = prev.timestampMillis + bucketWidthMills
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

function pluckCandleTimestamp(c: Candle): Date {
    return new Date(c.timestampMillis)
}


type NeedsOpenCandleParams = {
    now: Date
    desiredSearchEnd: Date
    endOfLastClosedBucket: Date
    bucketWidthMillis: number
}

function needsOpenCandle(
    params: NeedsOpenCandleParams,
): boolean {
    const { now, desiredSearchEnd, endOfLastClosedBucket, bucketWidthMillis } = params
    const nowT = now.getTime()
    const endOfLastClosedBucketT = endOfLastClosedBucket.getTime()
    const desiredSearchEndT = desiredSearchEnd.getTime()

    return nowT > endOfLastClosedBucketT && nowT < endOfLastClosedBucketT + bucketWidthMillis && desiredSearchEndT > endOfLastClosedBucketT
}

export const INTERNAL_RANGE_CACHE_ERROR_TYPE = "internal-range-cache-error" as const
export const INTERNAL_BOUNDS_ERROR_TYPE = "internal-bounds-error" as const

export type GetCandlesError =
    | { type: typeof INTERNAL_RANGE_CACHE_ERROR_TYPE; inner: GetBucketsInRangeError }
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

type ClosedCandlesStatus = {
    historyAscending: Candle[]
    status: RangeStatus
}

function mapClosedCandlesResult(
    closedCandles: Result<Candle[], GetBucketsInRangeError>,
    earliestOpt: Option<Date>,
): Result<ClosedCandlesStatus, GetCandlesError> {
    if (closedCandles.ok) {
        return Ok({
            historyAscending: closedCandles.val,
            status: { type: "ok" },
        })
    }
    if (closedCandles.val.type === "no-data") {
        return Ok({
            historyAscending: [],
            status: { type: "no-data-at-all" },
        })
    }
    if (closedCandles.val.type === "no-data-in-range") {
        if (earliestOpt.none) {
            return Ok({
                historyAscending: [],
                status: { type: "no-data-at-all" },
            })
        }
        return Ok({
            historyAscending: [],
            status: { type: "range-before-earliest", earliest: earliestOpt.val },
        })
    }
    return Err({ type: INTERNAL_RANGE_CACHE_ERROR_TYPE, inner: closedCandles.val })
}

function computeOpenCandle(
    mustGetOpenCandle: boolean,
    openCandleFromDb: Option<Candle>,
    historyAscending: Candle[],
    bucketWidthMills: number,
): Option<Candle> {
    if (!mustGetOpenCandle) {
        return None
    }
    if (openCandleFromDb.some) {
        return Some(openCandleFromDb.val)
    }
    if (historyAscending.length === 0) {
        return None
    }
    const defaultOpen = gapFillConstructor(bucketWidthMills)(historyAscending[historyAscending.length - 1])
    return Some(defaultOpen)
}


export async function getCandlesInRange<EntityKey>(params: GetCandlesParams<EntityKey>): Promise<Result<CandlesResponse, GetCandlesError>> {
    const { start, end, bucketWidthMillis, entityKey, getEarliestPriceDate, getLatestCandleBefore, getCandlesInRange, cache, now } = params
    const candleGapConstructor = gapFillConstructor(bucketWidthMillis)

    const searchRange = bounds.getBoundsAligned({
        bucketWidthMillis,
        start,
        end,
        now,
    })

    if (searchRange.err) {
        return Err(mapBoundsError(searchRange.val))
    }

    // unwrap value for convenience
    const mustGetOpenCandle = needsOpenCandle({ now, desiredSearchEnd: end, endOfLastClosedBucket: searchRange.val.endOfLastClosedBucket, bucketWidthMillis })

    const openCandleP = mustGetOpenCandle ? params.getOpenCandle() : Promise.resolve(None)
    const earliestP = getEarliestPriceDate()
    const closedCandlesP = getBucketsInRange<EntityKey, Candle>({
        cacheKeyNamespace: params.cacheKeyNamespace,
        start,
        end,
        bucketWidthMillis,
        entityKey,
        getEarliestBucketStart: async () => (await earliestP).unwrapOr(null),
        getLatestBucketBefore: (d) => getLatestCandleBefore(d).then(o => o.unwrapOr(null)),
        getBucketsInRange: getCandlesInRange,
        gapFillConstructor: candleGapConstructor,
        pluckBucketTimestamp: pluckCandleTimestamp,
        cache,
        now,
    })

    const [closedCandles, openCandleFromDb, earliestOpt] = await Promise.all([
        closedCandlesP,
        openCandleP,
        earliestP,
    ])

    const closedCandlesStatus = mapClosedCandlesResult(closedCandles, earliestOpt)

    return closedCandlesStatus.map(({ historyAscending, status }) => ({
        historyAscending,
        status,
        openCandle: computeOpenCandle(mustGetOpenCandle, openCandleFromDb, historyAscending, bucketWidthMillis),
    }))
}


function mapBoundsError(e: bounds.BoundsError): GetCandlesError {
    return { type: 'internal-bounds-error', inner: e }
}
