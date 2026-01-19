export type AtLeastOne<T> = {
  mostRecent: T
  /** sorted ascending by timestamp */
  older: T[]
}

type MillisSinceEpoch = number
type BucketTimestamps = AtLeastOne<MillisSinceEpoch>

function toBucketTimestamps<Bucket>(
  buckets: AtLeastOne<Bucket>,
  pluckBucketTimestamp: (b: Bucket) => Date,
): BucketTimestamps {
  return {
    mostRecent: pluckBucketTimestamp(buckets.mostRecent).getTime(),
    older: buckets.older.map(pluckBucketTimestamp).map(d => d.getTime()),
  }
}

export type LeftPadOptions<Bucket> = {
  desiredStart: Date
  // need this to calculate the number of buckets to pad
  // and how to handle an empty list
  bucketWidthMills: number

  // read the timestamp from the bucket (Date, in UTC)
  pluckBucketTimestamp: (b: Bucket) => Date

  /** The most recent bucket and the tail of buckets
   * We assume that the tail is sorted ascending by timestamp
   * And the list is completely filled
   */
  buckets: AtLeastOne<Bucket>

  defaultConstructor: (tsMillis: number) => Bucket
}

function getPadCount(desiredStart: Date, bucketWidthMills: number, buckets: AtLeastOne<MillisSinceEpoch>): number {
  // tail is sorted ascending by timestamp
  const oldestBucketMillis = buckets.older.length > 0 ? buckets.older[0] : buckets.mostRecent
  const desiredStartMillis = desiredStart.getTime()

  // the gap between the desired start and the oldest bucket
  const gapMillis = Math.max(0, oldestBucketMillis - desiredStartMillis)
  if (gapMillis % bucketWidthMills !== 0) {
    throw new Error("The bucket width must be a divisor back to the desired start")
  }

  // if
  // - desired start is 10
  // - oldestbucket start is 20
  // - and width is 10
  // - then we need to pad 1 bucket
  return Math.floor(gapMillis / bucketWidthMills)
}

export function leftPad<Bucket>(options: LeftPadOptions<Bucket>): Bucket[] {
  const { desiredStart, bucketWidthMills, pluckBucketTimestamp, buckets, defaultConstructor } = options
  const bucketTimestamps = toBucketTimestamps(buckets, pluckBucketTimestamp)
  const padCount = getPadCount(desiredStart, bucketWidthMills, bucketTimestamps)

  // ascending list of empty buckets
  const paddedEmptyBuckets: Bucket[] = []
  for (let i = 0; i < padCount; i++) {
    const tsMillis = desiredStart.getTime() + i * bucketWidthMills
    paddedEmptyBuckets.push(defaultConstructor(tsMillis))
  }

  return [...paddedEmptyBuckets, ...buckets.older, buckets.mostRecent]
}
