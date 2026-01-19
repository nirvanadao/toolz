export type ReduceBucketsOptions<Bucket> = {
  /** how many groups to create */
  numGroups: number

  // reduce the buckets into a single value
  reducer: (bs: Bucket[]) => Bucket

  buckets: Bucket[]
}

export function reduceBuckets<Bucket>(options: ReduceBucketsOptions<Bucket>): Bucket[] {
  const { numGroups, reducer, buckets } = options

  const result: Bucket[] = []

  if (buckets.length === 0) {
    return []
  }

  if (buckets.length % numGroups !== 0) {
    throw new Error("buckets.length must be divisible by numBucketsToGroup")
  }

  const groupWidth = buckets.length / numGroups

  for (let i = 0; i < buckets.length; i += groupWidth) {
    const chunk = buckets.slice(i, i + groupWidth)
    const aggregated = reducer(chunk)
    result.push(aggregated)
  }

  return result
}
