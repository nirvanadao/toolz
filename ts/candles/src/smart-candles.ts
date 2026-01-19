import { getCandlesInRange, GetCandlesInRange, GetEarliestPriceDate, GetLatestCandleBefore, GetOpenCandle } from "./get-candles"
import { Candle, ICache } from "./types"

const MINUTE_MILLIS = 60 * 1000
const HOUR_MILLIS = 60 * MINUTE_MILLIS

export enum CandleWidth {
    FIVE_MINUTES = MINUTE_MILLIS * 5,
    FIFTEEN_MINUTES = MINUTE_MILLIS * 15,
    THIRTY_MINUTES = MINUTE_MILLIS * 30,
    ONE_HOUR = HOUR_MILLIS * 1,
    TWO_HOURS = HOUR_MILLIS * 2,
    FOUR_HOURS = HOUR_MILLIS * 4,
    EIGHT_HOURS = HOUR_MILLIS * 8,
    TWELVE_HOURS = HOUR_MILLIS * 12,
    ONE_DAY = HOUR_MILLIS * 24,
}

const TARGET_CANDLE_COUNT = 250
const DAY_MILLIS = HOUR_MILLIS * 24

function lookbackHoursToCandleWidth(lookbackHours: number): CandleWidth {
    if (lookbackHours < 1) {
        return CandleWidth.FIVE_MINUTES
    }
    const bucketWidthHours = lookbackHours / TARGET_CANDLE_COUNT
    const bucketWidthMinutes = bucketWidthHours * 60
    return bucketWidthMinutesToCandleWidth(bucketWidthMinutes)
}

function bucketWidthMinutesToCandleWidth(bucketWidthMinutes: number): CandleWidth {
    if (bucketWidthMinutes < 5) {
        return CandleWidth.FIVE_MINUTES
    }
    if (bucketWidthMinutes < 15) {
        return CandleWidth.FIFTEEN_MINUTES
    }
    if (bucketWidthMinutes < 30) {
        return CandleWidth.THIRTY_MINUTES
    }
    if (bucketWidthMinutes < 60) {
        return CandleWidth.ONE_HOUR
    }
    if (bucketWidthMinutes < 2 * 60) {
        return CandleWidth.TWO_HOURS
    }
    if (bucketWidthMinutes < 4 * 60) {
        return CandleWidth.FOUR_HOURS
    }
    if (bucketWidthMinutes < 8 * 60) {
        return CandleWidth.EIGHT_HOURS
    }
    if (bucketWidthMinutes < 12 * 60) {
        return CandleWidth.TWELVE_HOURS
    }
    return CandleWidth.ONE_DAY
}

function rangeMillisToCandleWidth(rangeMillis: number): CandleWidth {
    const rangeHours = rangeMillis / HOUR_MILLIS
    return lookbackHoursToCandleWidth(rangeHours)
}


export type GetCandlesWithPaddingParams<EntityKey> = {
    /** namespace for the cache key */
    cacheKeyNamespace: string

    /** probably a string */
    entityKey: EntityKey

    /** Used for left-padding the domain to at least the minimum domain hours */
    defaultPrice: number

    /** How far back to look from now */
    lookBackDays: number

    /** Must provide current time, so that the open bucket can be determined */
    now: Date

    /** get the earliest bucket for the entity from the database */
    getEarliestPriceDate: GetEarliestPriceDate

    getLatestCandleBefore: GetLatestCandleBefore

    /** get the buckets in range for the entity */
    getCandlesInRange: GetCandlesInRange

    getOpenCandle: GetOpenCandle

    cache: ICache
}

export type RangeStatus =
    | { type: "ok" }
    | { type: "left-padded", earliestRealCandleMillis: number }
    | { type: "no-data-at-all" }


export type CandlesWithPaddingResponse = {
    historyAscending: Candle[]
    /** Will always have an open candle since query looks-back from now
     * In the edge case where now is at the exact millisecond boundary between buckets, the open candle will be:
     * - OHLC = last closed-candle close-price
    */
    openCandle: Candle
    status: RangeStatus
}


export async function getCandlesWithPadding<EntityKey>(params: GetCandlesWithPaddingParams<EntityKey>): Promise<CandlesWithPaddingResponse> {
    if (params.lookBackDays <= 0) {
        throw new Error("lookBackDays must be greater than 0")
    }

    const nowMillis = params.now.getTime()
    const lookBackMillis = params.lookBackDays * DAY_MILLIS

    // Default candle constructor for padding
    const defaultCandleCtr = (tsMillis: number): Candle => ({
        data: {
            open: params.defaultPrice,
            high: params.defaultPrice,
            low: params.defaultPrice,
            close: params.defaultPrice,
        },
        timestampMillis: tsMillis,
    })

    // Get earliest available data
    const earliest = await params.getEarliestPriceDate()

    // If no data exists at all, return full domain of default candles
    if (earliest.none) {
        const bucketWidthMillis = rangeMillisToCandleWidth(DAY_MILLIS)
        const lastClosedEndMillis = Math.floor(nowMillis / bucketWidthMillis) * bucketWidthMillis
        const domainStartMillis = lastClosedEndMillis - DAY_MILLIS
        const paddingCandles = generatePaddingCandles(domainStartMillis, lastClosedEndMillis, bucketWidthMillis, defaultCandleCtr)
        return {
            historyAscending: paddingCandles,
            openCandle: constructOpenCandle(paddingCandles, bucketWidthMillis, defaultCandleCtr, lastClosedEndMillis),
            status: { type: "no-data-at-all" },
        }
    }

    const earliestDate = earliest.val
    const earliestMillis = earliestDate.getTime()

    const desiredStartMillis = nowMillis - lookBackMillis
    const searchStartMillis = Math.max(desiredStartMillis, earliestMillis)
    const searchRangeMillis = Math.max(0, nowMillis - searchStartMillis)
    const bucketWidthMillis = rangeMillisToCandleWidth(searchRangeMillis)
    const lastClosedEndMillis = Math.floor(nowMillis / bucketWidthMillis) * bucketWidthMillis
    const domainStartMillis = searchRangeMillis < DAY_MILLIS
        ? lastClosedEndMillis - DAY_MILLIS
        : searchStartMillis
    const searchStart = new Date(searchStartMillis)

    // Get real candles
    const realCandlesResult = await getCandlesInRange({
        cacheKeyNamespace: params.cacheKeyNamespace,
        start: searchStart,
        end: params.now,
        bucketWidthMillis,
        entityKey: params.entityKey,
        getEarliestPriceDate: () => Promise.resolve(earliest),
        getLatestCandleBefore: params.getLatestCandleBefore,
        getCandlesInRange: params.getCandlesInRange,
        getOpenCandle: params.getOpenCandle,
        cache: params.cache,
        now: params.now,
    })

    // Handle errors
    if (realCandlesResult.err) {
        const paddingCandles = generatePaddingCandles(domainStartMillis, lastClosedEndMillis, bucketWidthMillis, defaultCandleCtr)
        return {
            historyAscending: paddingCandles,
            openCandle: constructOpenCandle(paddingCandles, bucketWidthMillis, defaultCandleCtr, lastClosedEndMillis),
            status: { type: "no-data-at-all" },
        }
    }

    const { historyAscending: realHistory, openCandle: realOpenCandle } = realCandlesResult.val

    // Determine if we need to left-pad (earliest data is after domain start)
    const firstRealCandleMillis = realHistory.length > 0 ? realHistory[0].timestampMillis : earliestMillis
    const needsPadding = firstRealCandleMillis > domainStartMillis

    // Build result
    let historyAscending: Candle[]
    let status: RangeStatus

    if (realHistory.length === 0) {
        // No candles in range - fill entire domain with defaults
        historyAscending = generatePaddingCandles(domainStartMillis, lastClosedEndMillis, bucketWidthMillis, defaultCandleCtr)
        status = needsPadding
            ? { type: "left-padded", earliestRealCandleMillis: earliestMillis }
            : { type: "no-data-at-all" }
    } else if (needsPadding) {
        // Have data but need to left-pad
        const paddingCandles = generatePaddingCandles(domainStartMillis, firstRealCandleMillis, bucketWidthMillis, defaultCandleCtr)
        historyAscending = [...paddingCandles, ...realHistory]
        status = { type: "left-padded", earliestRealCandleMillis: firstRealCandleMillis }
    } else {
        // No padding needed - data fills the domain
        historyAscending = realHistory
        status = { type: "ok" }
    }

    // Determine open candle - always provide one
    const openCandle = realOpenCandle.some
        ? realOpenCandle.val
        : constructOpenCandle(historyAscending, bucketWidthMillis, defaultCandleCtr, lastClosedEndMillis)

    return {
        historyAscending,
        openCandle,
        status,
    }
}

/** Construct an open candle from the last closed candle, or use default */
function constructOpenCandle(
    historyAscending: Candle[],
    bucketWidthMillis: number,
    defaultCandleCtr: (tsMillis: number) => Candle,
    openBucketStartMillis: number,
): Candle {
    if (historyAscending.length > 0) {
        const lastClosed = historyAscending[historyAscending.length - 1]
        return {
            data: {
                open: lastClosed.data.close,
                high: lastClosed.data.close,
                low: lastClosed.data.close,
                close: lastClosed.data.close,
            },
            timestampMillis: lastClosed.timestampMillis + bucketWidthMillis,
        }
    }
    return defaultCandleCtr(openBucketStartMillis)
}

/** Generate padding candles from startMillis (inclusive) up to but not including endMillis */
function generatePaddingCandles(
    startMillis: number,
    endMillis: number,
    bucketWidthMillis: number,
    candleCtr: (tsMillis: number) => Candle,
): Candle[] {
    const candles: Candle[] = []
    // Floor start to bucket boundary
    const alignedStart = Math.floor(startMillis / bucketWidthMillis) * bucketWidthMillis
    for (let ts = alignedStart; ts < endMillis; ts += bucketWidthMillis) {
        candles.push(candleCtr(ts))
    }
    return candles
}
