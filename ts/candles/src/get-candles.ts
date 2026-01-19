import { None, Option, Some } from "ts-results"
import { Candle, CandleData, ICache } from "./types"
import { getBucketsInRange, bounds } from "@nirvana-tools/cache-range-buckets"

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
    bucketWidthMills: number

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

export type Candles = {
    historyAscending: Candle[]
    /** The open candle begins at the end of the historyAscending array */
    openCandle: Option<Candle>
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
    bucketWidthMills: number
}
function needsOpenCandle(
    params: NeedsOpenCandleParams,
): boolean {
    const { now, desiredSearchEnd, endOfLastClosedBucket, bucketWidthMills } = params
    const nowT = now.getTime()
    const endOfLastClosedBucketT = endOfLastClosedBucket.getTime()
    const desiredSearchEndT = desiredSearchEnd.getTime()

    return nowT > endOfLastClosedBucketT && nowT < endOfLastClosedBucketT + bucketWidthMills && desiredSearchEndT > endOfLastClosedBucketT
}

export async function getCandlesInRange<EntityKey>(params: GetCandlesParams<EntityKey>): Promise<Candles> {
    const { start, end, bucketWidthMills, entityKey, getEarliestPriceDate, getLatestCandleBefore, getCandlesInRange, cache, now } = params
    const candleGapConstructor = gapFillConstructor(bucketWidthMills)

    const searchRange = bounds.getBoundsAligned({
        bucketWidthMills,
        start,
        end,
        now,
    }).unwrap()

    const mustGetOpenCandle = needsOpenCandle({ now, desiredSearchEnd: end, endOfLastClosedBucket: searchRange.endOfLastClosedBucket, bucketWidthMills })
    const openCandleP = mustGetOpenCandle ? params.getOpenCandle() : Promise.resolve(None)

    const closedCandlesP = getBucketsInRange<EntityKey, Candle>({
        cacheKeyNamespace: params.cacheKeyNamespace,
        start,
        end,
        bucketWidthMills,
        entityKey,
        getEarliestBucketStart: () => getEarliestPriceDate().then(o => o.unwrapOr(null)),
        getLatestBucketBefore: (d) => getLatestCandleBefore(d).then(o => o.unwrapOr(null)),
        getBucketsInRange: getCandlesInRange,
        gapFillConstructor: candleGapConstructor,
        pluckBucketTimestamp: pluckCandleTimestamp,
        cache,
        now,
    })

    const [closedCandlesRes, openCandleFromDb] = await Promise.all([closedCandlesP, openCandleP])

    if (closedCandlesRes.err) {
        // in this case, there is data in the DB, but nothing before the requested search start
        if (closedCandlesRes.val.type === 'no-data-in-range') {
            return {
                historyAscending: [],
                openCandle: None,
            }
        }

        throw new Error(`Unexpected error: ${closedCandlesRes.val}`)
    }


    const closedCandles = closedCandlesRes.val

    // the db might return no open candle, so we need to construct a default one
    const defaultOpenCandle = candleGapConstructor(closedCandles[closedCandles.length - 1])
    const openCandle = openCandleFromDb.unwrapOr(defaultOpenCandle)


    return {
        historyAscending: closedCandles,
        openCandle: mustGetOpenCandle ? Some(openCandle) : None,
    }

}
