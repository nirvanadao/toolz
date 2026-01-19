import { Err, None, Ok, Option, Result } from "ts-results"
import { getCandlesInRange, GetCandlesError, GetCandlesInRange, GetEarliestPriceDate, GetLatestCandleBefore, GetOpenCandle } from "./get-candles"
import { Candle, ICache } from "./types"

const DEFAULT_MIN_TIME_SPAN_HOURS = 24
const DEFAULT_TARGET_CANDLE_COUNT = 250
const MINUTE_MILLIS = 60 * 1000
const HOUR_MILLIS = 60 * MINUTE_MILLIS
const DAY_MILLIS = HOUR_MILLIS * 24

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


// ============================================================================
// Pure Functions
// ============================================================================

/** Maps a range (in millis) to an appropriate bucket width targeting the specified candle count */
export function computeBucketWidth(rangeMillis: number, targetCandleCount: number): CandleWidth {
    const rangeHours = rangeMillis / HOUR_MILLIS
    if (rangeHours < 1) {
        return CandleWidth.FIVE_MINUTES
    }
    const bucketWidthMinutes = (rangeHours / targetCandleCount) * 60

    if (bucketWidthMinutes <= 5) return CandleWidth.FIVE_MINUTES
    if (bucketWidthMinutes <= 15) return CandleWidth.FIFTEEN_MINUTES
    if (bucketWidthMinutes <= 30) return CandleWidth.THIRTY_MINUTES
    if (bucketWidthMinutes <= 60) return CandleWidth.ONE_HOUR
    if (bucketWidthMinutes <= 2 * 60) return CandleWidth.TWO_HOURS
    if (bucketWidthMinutes <= 4 * 60) return CandleWidth.FOUR_HOURS
    if (bucketWidthMinutes <= 8 * 60) return CandleWidth.EIGHT_HOURS
    if (bucketWidthMinutes <= 12 * 60) return CandleWidth.TWELVE_HOURS
    return CandleWidth.ONE_DAY
}

export type EffectiveSearchRange = {
    startMillis: number   // Where to start searching for data
    endMillis: number     // Where to stop (= now)
    rangeMillis: number   // end - start
}

/** Compute the effective search range, clamped by earliest available data */
export function computeEffectiveSearchRange(
    nowMillis: number,
    lookBackDays: number,
    earliestDataMillis: number,
): EffectiveSearchRange {
    const desiredStartMillis = nowMillis - (lookBackDays * DAY_MILLIS)
    const startMillis = Math.max(desiredStartMillis, earliestDataMillis)
    const endMillis = nowMillis
    const rangeMillis = Math.max(0, endMillis - startMillis)
    return { startMillis, endMillis, rangeMillis }
}

export type DomainBounds = {
    domainStartMillis: number     // Left edge (includes padding area)
    lastClosedEndMillis: number   // Right edge of closed candles (aligned to bucket)
    needsPadding: boolean         // If domain extends before search range
}

/** Compute domain bounds, extending to minimum time span if needed */
export function computeDomainBounds(
    nowMillis: number,
    searchStartMillis: number,
    bucketWidthMillis: number,
    minTimeSpanMillis: number,
): DomainBounds {
    // Floor now to bucket boundary for the right edge
    const lastClosedEndMillis = Math.floor(nowMillis / bucketWidthMillis) * bucketWidthMillis

    // Check if search range is less than minimum time span
    const searchRangeMillis = lastClosedEndMillis - searchStartMillis
    const needsPadding = searchRangeMillis < minTimeSpanMillis

    // If padding needed, extend domain to minimum; otherwise use search start
    const domainStartMillis = needsPadding
        ? lastClosedEndMillis - minTimeSpanMillis
        : searchStartMillis

    return { domainStartMillis, lastClosedEndMillis, needsPadding }
}

export type PaddedHistory = {
    candles: Candle[]
    status: RangeStatus
}

/** Build the final candle history, prepending padding candles if needed */
export function buildPaddedHistory(
    realCandles: Candle[],
    domain: DomainBounds,
    bucketWidthMillis: number,
    earliestDataMillis: number,
    defaultCandleCtr: (ts: number) => Candle,
): PaddedHistory {
    const { domainStartMillis, lastClosedEndMillis, needsPadding } = domain

    if (realCandles.length === 0) {
        // No real candles - fill entire domain with defaults
        const candles = generatePaddingCandles(domainStartMillis, lastClosedEndMillis, bucketWidthMillis, defaultCandleCtr)
        const status: RangeStatus = needsPadding
            ? { type: "left-padded", earliestRealCandleMillis: earliestDataMillis }
            : { type: "no-data-at-all" }
        return { candles, status }
    }

    const firstRealCandleMillis = realCandles[0].timestampMillis
    const realDataNeedsPadding = firstRealCandleMillis > domainStartMillis

    if (realDataNeedsPadding) {
        // Prepend padding candles before real data
        const paddingCandles = generatePaddingCandles(domainStartMillis, firstRealCandleMillis, bucketWidthMillis, defaultCandleCtr)
        const candles = [...paddingCandles, ...realCandles]
        const status: RangeStatus = { type: "left-padded", earliestRealCandleMillis: firstRealCandleMillis }
        return { candles, status }
    }

    // No padding needed
    return { candles: realCandles, status: { type: "ok" } }
}

/** Compute the open candle - always returns one */
export function computeOpenCandle(
    realOpenCandle: Option<Candle>,
    closedHistory: Candle[],
    bucketWidthMillis: number,
    defaultCandleCtr: (ts: number) => Candle,
    openBucketStartMillis: number,
): Candle {
    // Use real open candle if available
    if (realOpenCandle.some) {
        return realOpenCandle.val
    }

    // Construct from last closed candle
    if (closedHistory.length > 0) {
        const lastClosed = closedHistory[closedHistory.length - 1]
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

    // Fall back to default
    return defaultCandleCtr(openBucketStartMillis)
}

/** Generate padding candles from startMillis (inclusive) up to but not including endMillis */
export function generatePaddingCandles(
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

/** Create a default candle constructor with a fixed price */
export function makeDefaultCandleCtr(defaultPrice: number): (tsMillis: number) => Candle {
    return (tsMillis: number): Candle => ({
        data: {
            open: defaultPrice,
            high: defaultPrice,
            low: defaultPrice,
            close: defaultPrice,
        },
        timestampMillis: tsMillis,
    })
}

// ============================================================================
// Types
// ============================================================================

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

    /** Minimum time span in hours  Will left-pad the domain to at least this many hours */
    minTimeSpanHours?: number

    /** Target number of candles to return */
    targetCandleCount?: number
}

export type RangeStatus =
    | { type: "ok" }
    | { type: "left-padded"; earliestRealCandleMillis: number }
    | { type: "no-data-at-all" }


export type CandlesWithPaddingResponse = {
    historyAscending: Candle[]
    /** Will always have an open candle since query looks-back from now */
    openCandle: Candle
    status: RangeStatus
    bucketWidthMillis: number
}

// ============================================================================
// Main Function
// ============================================================================

/**
 * Dynamically pick the best "bucket width" for the given lookback days
 *
 * 1. Take into account the _actual_ data present in the database
 *    If requested lookback is 180 days but only 7 days of data exists,
 *    use a tighter bucket width than expected.
 *
 * 2. Always make the time span at least 24h. Left-pad "default" candles if necessary.
 *    A "default" candle uses the default initial price of the market.
 *
 * 3. Target ~250 candles for the time span
 *
 * 4. Always return an "open candle"
 *    Even at exact bucket boundary, carry over the close price of the last closed candle.
 */
export async function getCandlesWithPadding<EntityKey>(
    params: GetCandlesWithPaddingParams<EntityKey>
): Promise<Result<CandlesWithPaddingResponse, GetCandlesError>> {
    if (params.lookBackDays <= 0) {
        throw new Error("lookBackDays must be greater than 0")
    }

    const minTimeSpanHours = params.minTimeSpanHours ?? DEFAULT_MIN_TIME_SPAN_HOURS
    const targetCandleCount = params.targetCandleCount ?? DEFAULT_TARGET_CANDLE_COUNT
    const minTimeSpanMillis = minTimeSpanHours * HOUR_MILLIS

    const nowMillis = params.now.getTime()
    const defaultCandleCtr = makeDefaultCandleCtr(params.defaultPrice)

    // 1. Get earliest data timestamp
    const earliest = await params.getEarliestPriceDate()

    // 2. Handle no-data-at-all case early
    if (earliest.none) {
        const bucketWidthMillis = computeBucketWidth(minTimeSpanMillis, targetCandleCount)
        const lastClosedEndMillis = Math.floor(nowMillis / bucketWidthMillis) * bucketWidthMillis
        const domainStartMillis = lastClosedEndMillis - minTimeSpanMillis
        const candles = generatePaddingCandles(domainStartMillis, lastClosedEndMillis, bucketWidthMillis, defaultCandleCtr)
        const openCandle = computeOpenCandle(None, candles, bucketWidthMillis, defaultCandleCtr, lastClosedEndMillis)
        return Ok({
            historyAscending: candles,
            openCandle,
            status: { type: "no-data-at-all" },
            bucketWidthMillis
        })
    }

    const earliestMillis = earliest.val.getTime()

    // 3. Compute effective search range (clamped by earliest data)
    const searchRange = computeEffectiveSearchRange(nowMillis, params.lookBackDays, earliestMillis)

    // 4. Compute bucket width from search range
    const bucketWidthMillis = computeBucketWidth(searchRange.rangeMillis, targetCandleCount)

    // 5. Compute domain bounds (may extend beyond search range for minimum time span)
    const domain = computeDomainBounds(nowMillis, searchRange.startMillis, bucketWidthMillis, minTimeSpanMillis)

    // 6. Fetch real candles
    const realCandlesResult = await getCandlesInRange({
        cacheKeyNamespace: params.cacheKeyNamespace,
        start: new Date(searchRange.startMillis),
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

    // 7. Propagate fetch errors
    if (realCandlesResult.err) {
        return Err(realCandlesResult.val)
    }

    // 8. Build padded history
    const { candles, status } = buildPaddedHistory(
        realCandlesResult.val.historyAscending,
        domain,
        bucketWidthMillis,
        earliestMillis,
        defaultCandleCtr,
    )

    // 9. Compute open candle
    const openCandle = computeOpenCandle(
        realCandlesResult.val.openCandle,
        candles,
        bucketWidthMillis,
        defaultCandleCtr,
        domain.lastClosedEndMillis,
    )

    return Ok({ historyAscending: candles, openCandle, status, bucketWidthMillis })
}
