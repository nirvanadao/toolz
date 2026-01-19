import { Result, Ok, Err } from "ts-results"

const MINUTE_MILLIS = 60 * 1000
const HOUR_MILLIS = 60 * MINUTE_MILLIS
const DAY_MILLIS = 24 * HOUR_MILLIS

const LOWER_BOUND_MILLIS = MINUTE_MILLIS
const UPPER_BOUND_MILLIS = DAY_MILLIS

export type IntervalError = { type: "invalid-interval", message: string }

/** Ceil the date to the nearest interval boundary */
export function ceilToInterval(d: Date, intervalMillis: number): Result<Date, IntervalError> {
    const result = floorToInterval(d, intervalMillis)
    if (result.err) {
        return result
    }
    const floored = result.val
    const ceiled = new Date(floored.getTime() + intervalMillis)
    return Ok(ceiled)
}

/** Floor the date to the nearest interval boundary */
export function floorToInterval(d: Date, intervalMillis: number): Result<Date, IntervalError> {
    if (intervalMillis < LOWER_BOUND_MILLIS) {
        return Err({ type: "invalid-interval", message: `interval must be greater than ${LOWER_BOUND_MILLIS}ms` })
    }
    if (intervalMillis > UPPER_BOUND_MILLIS) {
        return Err({ type: "invalid-interval", message: `interval must be less than ${UPPER_BOUND_MILLIS}ms` })
    }
    
    // intervals must repeat evenly within the upper bound
    // for example, if upper bound is 1 day, intervals must be values like:
    // - 5 minutes
    // - 10 minutes
    // - 1 hour
    // - 12 hours
    // - 24 hours
    if (UPPER_BOUND_MILLIS % intervalMillis !== 0) {
        return Err({ type: "invalid-interval", message: `interval must be a divisor of ${UPPER_BOUND_MILLIS}ms` })
    }

    const ms = d.getTime()
    const intervalStart = Math.floor(ms / intervalMillis) * intervalMillis
    return Ok(new Date(intervalStart))
}
