const HOUR_MILLIS = 1000 * 60 * 60

/** The boundaries of the hourly buckets */
export type HourlyBucketBoundaries = {
  firstBucketStart: Date
  lastBucketStart: Date
  lastBucketEnd: Date
}

export type GetBucketWidthFromEarliestDataParams = {
  /** The lookback hours */
  lookbackHours: number
  /** The desired number of buckets */
  desiredBucketCount: number
  /** The earliest data known */
  earliestData: Date
  /** Minimum number of buckets */
  minBuckets: number

  /** The end time of the data */
  end: Date
}

function truncateHour(d: Date) {
  const dd = new Date(d.getTime())
  dd.setMinutes(0, 0, 0)
  return dd
}

function ceilToHour(d: Date): Date {
  const t = truncateHour(d)
  const ms = t.getTime() + HOUR_MILLIS
  return new Date(ms)
}

/** The boundaries of the buckets
 * Given a preferred number of buckets, and a span of time,
 */
export type BucketBoundaries = {
  firstBucketStart: Date
  lastBucketStart: Date
  lastBucketEnd: Date
  // the number of buckets in the range
  bucketCount: number
}

export function calculateBucketWidthHours(spanHours: number, desiredBucketCount: number): number {
  if (spanHours <= 0) {
    throw new Error("Span hours must be greater than 0")
  }
  if (desiredBucketCount <= 0) {
    throw new Error("Desired bucket count must be greater than 0")
  }

  const div = Math.floor(spanHours / desiredBucketCount)
  if (div === 0) {
    return 1
  }

  return div
}

/** Get ideal bucket boundaries from:
 * - Knowing the earliest data in a series
 * - Knowing the desired number of buckets
 * - Knowing the end time of the data (the exclusive end time of the last bucket)
 */
export function getBucketBoundariesFromEarliestData(params: GetBucketWidthFromEarliestDataParams): BucketBoundaries {
  const { lookbackHours, desiredBucketCount, earliestData, minBuckets, end: endParam } = params

  if (minBuckets <= 0) {
    throw new Error("Min buckets must be greater than 0")
  }
  if (minBuckets > desiredBucketCount) {
    throw new Error("Min buckets must be less than or equal to desired bucket count")
  }
  if (lookbackHours <= 0) {
    throw new Error("Lookback hours must be greater than 0")
  }
  if (desiredBucketCount <= 0) {
    throw new Error("Desired bucket count must be greater than 0")
  }

  // if there is no data, return the min buckets
  // with 1 hour data
  if (earliestData >= endParam) {
    const bucketWidth = 1
    const bucketCount = minBuckets
    const lastBucketEnd = ceilToHour(endParam)
    const lastBucketStart = new Date(lastBucketEnd.getTime() - bucketWidth * HOUR_MILLIS)
    const firstBucketStart = new Date(lastBucketEnd.getTime() - bucketCount * HOUR_MILLIS)

    return {
      firstBucketStart,
      lastBucketStart,
      lastBucketEnd,
      bucketCount,
    }
  }

  const earliestTruncated = truncateHour(earliestData)
  const end = ceilToHour(endParam)

  const firstBucketStart = new Date(end.getTime() - lookbackHours * HOUR_MILLIS)

  // the true start is the greater of the first bucket start and the earliest data
  const trueStart = new Date(Math.max(firstBucketStart.getTime(), earliestTruncated.getTime()))

  // how far back in time the data goes
  // floored to the hour
  const trueLookbackHours = (end.getTime() - trueStart.getTime()) / HOUR_MILLIS

  // what would the width of the buckets be if we had the desired number of buckets?
  const trueBucketWidth = calculateBucketWidthHours(trueLookbackHours, desiredBucketCount)
  const trueBucketCount = Math.floor(trueLookbackHours / trueBucketWidth)

  // since desiredBucketCount is gte minBuckets,
  // we know that if trueBucketWidth is > 1
  // then we are done - we got the desired number of buckets

  if (trueBucketWidth > 1) {
    return {
      firstBucketStart: trueStart,
      lastBucketEnd: end,
      lastBucketStart: new Date(end.getTime() - trueBucketWidth * HOUR_MILLIS),
      bucketCount: trueBucketCount,
    }
  }

  // the bucket count must be at least minBuckets
  const coercedBucketCount = Math.max(minBuckets, trueBucketCount)
  const coercedFirstBucketStart = new Date(end.getTime() - coercedBucketCount * HOUR_MILLIS)
  // the bucket width is 1 hour
  // which is the minimum
  const lastBucketStart = new Date(end.getTime() - HOUR_MILLIS)

  return {
    firstBucketStart: coercedFirstBucketStart,
    lastBucketStart,
    lastBucketEnd: end,
    bucketCount: coercedBucketCount,
  }
}

/** Calculate the hourly boundaries for now */
export function getHourlyBoundariesForNow(bucketWidthHours: number, lookbackHours: number): HourlyBucketBoundaries {
  const now = new Date()
  now.setMinutes(0, 0, 0)

  // the end of the last bucket
  const lastBucketEnd = new Date(now.getTime() + HOUR_MILLIS)

  // the last bucket includes the current hour
  const lastBucketStart = new Date(lastBucketEnd.getTime() - bucketWidthHours * HOUR_MILLIS)

  const spanMillis = lookbackHours * HOUR_MILLIS
  const firstBucketStart = new Date(lastBucketEnd.getTime() - spanMillis)

  return { firstBucketStart, lastBucketStart, lastBucketEnd }
}

export type Envelope<T> = {
  timestamp: Date
  value: T
}

export type AggregatedEnvelope<T> = {
  start: Date
  value: T
}

const beginInclusive = <T>(d: Date, r: Envelope<T>) => r.timestamp.getTime() >= d.getTime()

const endExclusive = <T>(d: Date, r: Envelope<T>) => r.timestamp.getTime() < d.getTime()

const inBucket =
  (begin: Date, widthSeconds: number) =>
  <T>(r: Envelope<T>) => {
    const end = new Date(begin.getTime() + widthSeconds * 1000)
    return beginInclusive(begin, r) && endExclusive(end, r)
  }

/** Note that the span between desiredStart and desiredEnd must be a whoule multiple of widthSeconds */
export type FillEmptyOptions<T> = {
  /** the width of the time buckets in seconds */
  widthSeconds: number
  /** the start time of the data (inclusive) */
  desiredStart: Date
  /** the number of buckets to fill */
  bucketCount: number
  /** the function to aggregate the records into a single value
   * Typically, if the list is empty, the function should return the "empty" default value.
   */
  aggregationFunction: (records: T[]) => T
}

/**
 * Fill empty records into the data
 * Left pads, and right pads the data to the desired start and end times.
 * @param options - the options for the fill
 * @param records - the records to fill
 * @returns the filled records
 */
export function fillEmpty<T>(options: FillEmptyOptions<T>, records: Envelope<T>[]): AggregatedEnvelope<T>[] {
  const { widthSeconds, bucketCount, desiredStart, aggregationFunction } = options

  if (widthSeconds <= 0) {
    throw new Error("Width seconds must be greater than 0")
  }

  // get the start times of the buckets
  const bucketStarts = Array.from(
    { length: bucketCount },
    (_, i) => new Date(desiredStart.getTime() + i * widthSeconds * 1000),
  )

  // now make groups in each bucket
  const bucketed = bucketStarts.map((startTimestamp) => {
    const fn = inBucket(startTimestamp, widthSeconds)
    const recordsInBucket = records.filter(fn)
    return { start: startTimestamp, records: recordsInBucket }
  })

  // aggregate the records into a single value
  const aggd = bucketed.map((b) => {
    return {
      start: b.start,
      value: aggregationFunction(b.records.map((r) => r.value)),
    }
  })

  return aggd
}

export type FillEmptyWithCarryForwardOptions<T> = {
  /** the width of the time buckets in seconds */
  widthSeconds: number
  /** the start time of the data (inclusive) */
  desiredStart: Date
  /** the number of buckets to fill */
  bucketCount: number
  /** the function to average records into a single value */
  averageFunction: (records: T[]) => T
  /** the empty value to use for left-padding before any data exists */
  emptyValue: T
}

/**
 * Fill empty records with carry-forward behavior
 * - Averages records within a bucket
 * - Carries forward the last known value for gaps
 * - Left-pads with emptyValue before the first data point
 */
export function fillEmptyWithCarryForward<T>(
  options: FillEmptyWithCarryForwardOptions<T>,
  records: Envelope<T>[],
): AggregatedEnvelope<T>[] {
  const { widthSeconds, bucketCount, desiredStart, averageFunction, emptyValue } = options

  if (widthSeconds <= 0) {
    throw new Error("Width seconds must be greater than 0")
  }

  // get the start times of the buckets
  const bucketStarts = Array.from(
    { length: bucketCount },
    (_, i) => new Date(desiredStart.getTime() + i * widthSeconds * 1000),
  )

  // group records into buckets
  const bucketed = bucketStarts.map((startTimestamp) => {
    const fn = inBucket(startTimestamp, widthSeconds)
    const recordsInBucket = records.filter(fn)
    return { start: startTimestamp, records: recordsInBucket }
  })

  // build result with carry-forward
  const result: AggregatedEnvelope<T>[] = []
  let lastKnownValue: T = emptyValue

  for (const bucket of bucketed) {
    if (bucket.records.length > 0) {
      // average the records in this bucket
      const averaged = averageFunction(bucket.records.map((r) => r.value))
      lastKnownValue = averaged
      result.push({ start: bucket.start, value: averaged })
    } else {
      // carry forward the last known value
      result.push({ start: bucket.start, value: lastKnownValue })
    }
  }

  return result
}
