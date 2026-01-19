import { Err,  Result } from "ts-results"
import { floorToInterval, IntervalError } from "./time"

/** Get range params for the fetch */
export type Bounds = {
  /** Inclusive start of the first bucket */
  startOfFirstBucket: Date

  /** Exclusive end of the last closed bucket */
  endOfLastClosedBucket: Date
}

export type BoundsError = { type: "bounds-invalid-interval", message: string } | { type: 'bounds-start-after-end', message: string } | { type: 'bounds-invalid-bucket-width', message: string }

export type GetBoundsAlignedParams = {
  bucketWidthMills: number
  start: Date
  end: Date
  now: Date
}

export function getBoundsAligned(params: GetBoundsAlignedParams): Result<Bounds, BoundsError> {
  const { bucketWidthMills, start, end, now } = params

  if (bucketWidthMills <= 0) {
    return Err({ type: 'bounds-invalid-bucket-width', message: `bucket width must be greater than 0ms` })
  }

  if (start >= end) {
    return Err({ type: 'bounds-start-after-end', message: `start must be before end: start=${start.toISOString()}, end=${end.toISOString()}` })
  }

  // if we need the open bucket, then the last closed bucket is the truncated end
  // otherwise, all buckets in range are closed
  const endOfLastClosedBucket = getEndOfLastClosedBucket(now, bucketWidthMills, end)
  const startOfFirstBucket = getStartOfFirstBucket(start, bucketWidthMills)

  return Result.all(
    startOfFirstBucket,
    endOfLastClosedBucket,
  ).map(([startOfFirstBucket, endOfLastClosedBucket]) => ({ startOfFirstBucket, endOfLastClosedBucket}))
}

export function needsOpenBucket(bounds: Bounds, now: Date): boolean {
    return now > bounds.endOfLastClosedBucket
}

/** Clamp to reality */
function clampToNow(requestedEnd: Date, now: Date): Date {
    return requestedEnd > now ? now : requestedEnd
}

const mapIntervalError = (msg: string) => (e: IntervalError): BoundsError => ({ type: 'bounds-invalid-interval', message: `${msg}: ${e.message}` })

function getEndOfLastClosedBucket(
    now: Date,
    bucketWidthMills: number,
    requestedEnd: Date
): Result<Date, BoundsError> {
    // clamp to reality
    const clampedEnd = clampToNow(requestedEnd, now)
    // truncate to the requested interval width in milliseconds
    const endTruncated = floorToInterval(clampedEnd, bucketWidthMills).mapErr(mapIntervalError('error flooring end'))

    return endTruncated
}

function getStartOfFirstBucket(
    start: Date,
    bucketWidthMills: number,
): Result<Date, BoundsError> {
    return floorToInterval(start, bucketWidthMills).mapErr(mapIntervalError('error flooring start'))
}


