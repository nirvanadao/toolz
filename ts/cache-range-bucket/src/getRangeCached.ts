import { Err, Ok, Result } from "ts-results"
import { ICache } from "./types"
import { Bounds, BoundsError, getBoundsAligned } from "./utils/bounds"
import { andThenAsync, catchToResult } from "./utils/catch-to-result"

export type DbRangeGetter<Bucket> = (
  /** inclusive start */
  inclusiveStart: Date,
  /** exclusive end */
  exclusiveEnd: Date,
) => Promise<Bucket[]>

/** Returns the earliest bucket in the database, or else null if there is no data */
export type DbEarliestBucketStartGetter = () => Promise<Date | null>

/** Get the latest bucket before a given timestamp 
 * Used for the "gap filling" seed
*/
export type DbLatestBucketBeforeGetter<Bucket> = (ts: Date) => Promise<Bucket | null>


export type GetBucketsInRangeParams<EntityKey, Bucket> = {
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
  getEarliestBucketStart: DbEarliestBucketStartGetter

  getLatestBucketBefore: DbLatestBucketBeforeGetter<Bucket>

  /** get the buckets in range for the entity */
  getBucketsInRange: DbRangeGetter<Bucket>

  /** constructor to use for filling gaps
   * Takes the previous bucket and returns the next bucket to fill the gap
   * 
   * Since the bucket width is known, the gap fill constructor can be a simple function that returns a new bucket with the correct timestamp
   */
  gapFillConstructor: (prev: Bucket) => Bucket

  /** pluck the timestamp from the bucket (Date, in UTC) */
  pluckBucketTimestamp: (b: Bucket) => Date

  cache: ICache

  /** Must provide current time, so that the open bucket can be determined */
  now: Date
}

/** No data at all in the database */
export type NoDataAtAllResult = {
  type: "no-data-at-all"
}

export type SearchRangeEndsBeforeEarliestResult = {
  type: "search-range-ends-before-earliest"
  earliestDataInDb: Date
}

export type OkResult<Bucket> = {
  type: "ok"
  /** The bounded start of the search range (aligned and clamped to the earliest data in the database) */
  effectiveSearchStart: Date
  /** The bounded end of the search range (aligned and clamped to the current time) */
  effectiveSearchEnd: Date
  /** The earliest data in the database */
  earliestDataInDb: Date
  buckets: Bucket[]
}

export type RangeResult<Bucket> =
  NoDataAtAllResult
  | SearchRangeEndsBeforeEarliestResult
  | OkResult<Bucket>



/** Get the hourly buckets in range for the entity
 * Will fill in gaps in the range if the data is sparse
 * The first bucket is the actual first bucket in the database
 */
export async function getBucketsInRange<EntityKey, Bucket>(
  params: GetBucketsInRangeParams<EntityKey, Bucket>,
): Promise<Result<RangeResult<Bucket>, GetBucketsInRangeError>> {

  // get the effective range of the search
  const effectiveSearchRange = await findEffectiveSearchRange(params)

  const cachedResult = await andThenAsync(effectiveSearchRange, (r => getFromCache<EntityKey, Bucket>(
    params.cacheKeyNamespace,
    params.bucketWidthMillis,
    params.entityKey,
    r.firstBucketStartInclusive,
    r.lastClosedBucketStartInclusive,
    params.cache,
  )))


  // check if the cached result is complete
  // that is, does it have the expected number of buckets
  const isCachedResultComplete = Result.all(cachedResult, effectiveSearchRange).map(([cachedResult, effectiveSearchRange]) => cacheIsComplete(cachedResult, effectiveSearchRange, params.bucketWidthMillis, params.pluckBucketTimestamp))

  // now, if the cache is complete, return it
  // else get from db and set to cache
  const filledBuckets = await andThenAsync(
    Result.all(isCachedResultComplete, cachedResult, effectiveSearchRange),
    async ([isCachedResultComplete, cachedResult, effectiveSearchRange]) => {
      if (isCachedResultComplete) {
        return Promise.resolve(Ok(cachedResult))
      }
      return getRangeFromDbAndSetToCache(
        params.cache,
        params.cacheKeyNamespace,
        params.entityKey,
        params.getBucketsInRange,
        params.getLatestBucketBefore,
        params.pluckBucketTimestamp,
        params.gapFillConstructor,
        params.bucketWidthMillis,
        effectiveSearchRange.firstBucketStartInclusive,
        effectiveSearchRange.lastClosedBucketStartInclusive,
      )
    }
  )

  return filledBuckets
}

/** No data at all in the database */
const NO_DATA_ERROR_TYPE = 'no-data' as const
/** Search range ends before earliest data in the database */
const NO_DATA_IN_RANGE_ERROR_TYPE = 'no-data-in-range' as const
const EARLIEST_BUCKET_ERROR_TYPE = 'get-earliest-bucket-error' as const
const INTERNAL_ERROR_TYPE = 'internal-error' as const
const BOUNDS_ERROR_TYPE = 'bounds-error' as const
const ZRANGE_GET_ERROR_TYPE = 'zrange-get-error' as const
const RANGE_FROM_DB_ERROR_TYPE = 'range-from-db-error' as const
const DB_GET_LATEST_BUCKET_BEFORE_NULL_ERROR_TYPE = 'db-get-latest-bucket-before-null-error' as const
const DB_GET_LATEST_BUCKET_BEFORE_ERROR_TYPE = 'db-get-latest-bucket-before-error' as const

export type GetBucketsInRangeError = { type: typeof DB_GET_LATEST_BUCKET_BEFORE_NULL_ERROR_TYPE } |
{ type: typeof NO_DATA_ERROR_TYPE } |
{ type: typeof NO_DATA_IN_RANGE_ERROR_TYPE } |
{ type: typeof INTERNAL_ERROR_TYPE; cause: unknown } |
{ type: typeof EARLIEST_BUCKET_ERROR_TYPE; cause: unknown } |
{ type: typeof BOUNDS_ERROR_TYPE; internal: BoundsError } |
{ type: typeof ZRANGE_GET_ERROR_TYPE; cause: unknown } |
{ type: typeof RANGE_FROM_DB_ERROR_TYPE; cause: unknown } |
{ type: typeof DB_GET_LATEST_BUCKET_BEFORE_ERROR_TYPE; cause: unknown }

function mapBoundsError(e: BoundsError): GetBucketsInRangeError {
  return { type: 'bounds-error', internal: e }
}

/** Get the earliest bucket from the database
 * This is used to determine the effective start time for a search
 * And also whether there is any data at all in the database
 */
async function getEarliestBucketFromDb(fn: DbEarliestBucketStartGetter): Promise<Result<Date, GetBucketsInRangeError>> {
  const errMapper = <E>(e: E) => ({ type: EARLIEST_BUCKET_ERROR_TYPE, cause: e })
  const earliestRes = await catchToResult(fn(), errMapper)
  return earliestRes.andThen(b => b === null ? Err({ type: NO_DATA_ERROR_TYPE }) : Ok(b))
}

type EffectiveStartTimeParams = {
  dbEarliestBucketStart: Date
  boundedStart: Date
}

function intoEffectiveStartTimeParams<E>(
  dbEarliestBucketStart: Result<Date, E>,
  bounds: Result<Bounds, E>
): Result<EffectiveStartTimeParams, E> {
  const boundedStart = bounds.map(b => b.startOfFirstBucket)
  return Result.all(dbEarliestBucketStart, boundedStart).map(([dbEarliestBucketStart, boundedStart]) => ({
    dbEarliestBucketStart,
    boundedStart,
  }))
}

/** Only fetch from cache/db up to the effective start time
 * Which may be later than the bounded start due to the earliest bucket start
 */
function effectiveStartTime(params: EffectiveStartTimeParams): Date {
  const { dbEarliestBucketStart, boundedStart } = params
  const t = Math.max(dbEarliestBucketStart.getTime(), boundedStart.getTime())
  return new Date(t)
}

/** Get the effective search time (which is the max of the requested start and the actual earliest bucket start in the database) */
async function findEffectiveSearchStart<K, B>(
  params: GetBucketsInRangeParams<K, B>,
): Promise<Result<Date, GetBucketsInRangeError>> {
  const bounds = getBoundsAligned({
    bucketWidthMillis: params.bucketWidthMillis,
    start: params.start,
    end: params.end,
    now: params.now,
  }).mapErr(mapBoundsError)

  const dbEarliestBucket = await getEarliestBucketFromDb(params.getEarliestBucketStart)
  const args = intoEffectiveStartTimeParams(dbEarliestBucket, bounds)
  return args.map(effectiveStartTime)
}

type EffectiveSearchEnd = {
  lastClosedBucketStartInclusive: Date
  lastClosedBucketEndExclusive: Date
}

/** Get the effective search end time (which is the end of the last closed bucket) */
function findEffectiveSearchEnd<K, B>(
  params: GetBucketsInRangeParams<K, B>,
): Result<EffectiveSearchEnd, GetBucketsInRangeError> {
  const bounds = getBoundsAligned({
    bucketWidthMillis: params.bucketWidthMillis,
    start: params.start,
    end: params.end,
    now: params.now,
  }).mapErr(mapBoundsError)

  const lastClosedBucketEndExclusive = bounds.map(b => b.endOfLastClosedBucket)
  const lastClosedBucketStartInclusive = lastClosedBucketEndExclusive.map(d => new Date(d.getTime() - params.bucketWidthMillis))

  return Result.all(lastClosedBucketStartInclusive, lastClosedBucketEndExclusive).map(([lastClosedBucketStartInclusive, lastClosedBucketEndExclusive]) => ({
    lastClosedBucketStartInclusive,
    lastClosedBucketEndExclusive,
  }))
}

type EffectiveSearchRange = {
  firstBucketStartInclusive: Date
  lastClosedBucketStartInclusive: Date
  lastClosedBucketEndExclusive: Date
}

async function findEffectiveSearchRange<K, B>(
  params: GetBucketsInRangeParams<K, B>,
): Promise<Result<EffectiveSearchRange, GetBucketsInRangeError>> {
  const effectiveSearchStart = await findEffectiveSearchStart(params)
  const effectiveSearchEnd = findEffectiveSearchEnd(params)
  return Result.all(effectiveSearchStart, effectiveSearchEnd).andThen(([effectiveSearchStart, effectiveSearchEnd]) => {
    // validate that effective start is not after effective end
    // this can happen if the earliest bucket in the DB is after the requested range
    if (effectiveSearchStart.getTime() > effectiveSearchEnd.lastClosedBucketStartInclusive.getTime()) {
      return Err({ type: NO_DATA_IN_RANGE_ERROR_TYPE })
    }
    return Ok({
      firstBucketStartInclusive: effectiveSearchStart,
      lastClosedBucketStartInclusive: effectiveSearchEnd.lastClosedBucketStartInclusive,
      lastClosedBucketEndExclusive: effectiveSearchEnd.lastClosedBucketEndExclusive,
    })
  })
}



/** Check whether the cached values are complete for the search range */
function cacheIsComplete<B>(
  cachedResult: B[],
  searchRange: EffectiveSearchRange,
  bucketWidthMills: number,
  pluckBucketTimestamp: (b: B) => Date,
): boolean {
  const expectedCount = expectedBucketCount(
    {
      oldestBucketStart: searchRange.firstBucketStartInclusive,
      newestBucketStart: searchRange.lastClosedBucketStartInclusive,
      bucketWidthMillis: bucketWidthMills,
    }
  )

  const actualCount = cachedResult.length
  // short circuit if the count is not expected
  if (actualCount !== expectedCount) {
    return false
  }

  // handle empty range case (both actual and expected are 0)
  if (actualCount === 0) {
    return true
  }

  const isSorted = isSortedAscending(pluckBucketTimestamp)(cachedResult)

  if (!isSorted) {
    console.error("cached buckets are not sorted - how did this happen?")
  }

  const cachedStart = pluckBucketTimestamp(cachedResult[0]).getTime()
  const cachedEnd = pluckBucketTimestamp(cachedResult[cachedResult.length - 1]).getTime()
  const hasExpectedStart = searchRange.firstBucketStartInclusive.getTime() === cachedStart
  const hasExpectedEnd = searchRange.lastClosedBucketStartInclusive.getTime() === cachedEnd
  return hasExpectedStart && hasExpectedEnd && isSorted
}

export type FillGapsInRangeParams<Bucket> = {
  /** pluck the timestamp from the bucket (Date, in UTC) */
  pluckBucketTimestamp: (b: Bucket) => Date,
  /** must provide the desired oldest bucket start in case there are gaps in the oldest data */
  desiredOldestBucketStart: Date,
  /** must provide the desired newest bucket start (inclusive) in case there are gaps in the most recent data */
  desiredNewestBucketStart: Date,
  /** width of the buckets in milliseconds */
  bucketWidthMillis: number,
  /** constructor to use for filling gaps
   * Takes the previous bucket and returns the next bucket to fill the gap
   * 
   * Since the bucket width is known, the gap fill constructor can be a simple function that returns a new bucket with the correct timestamp
   */
  gapFillConstructor: (prev: Bucket) => Bucket,
  /** the bucket to use as the seed for filling gaps */
  seedBucket: Bucket,
  /** the sparse buckets to fill gaps in */
  sparseBuckets: Bucket[],
}

export function fillGapsInRange<Bucket>(
  params: FillGapsInRangeParams<Bucket>,
): Bucket[] {
  const { pluckBucketTimestamp, desiredOldestBucketStart, desiredNewestBucketStart, bucketWidthMillis, gapFillConstructor, seedBucket, sparseBuckets } = params

  const desiredOldestBucketStartMillis = desiredOldestBucketStart.getTime()
  const desiredNewestBucketStartMillis = desiredNewestBucketStart.getTime()

  // sanity checks

  if (pluckBucketTimestamp(seedBucket).getTime() > desiredOldestBucketStartMillis) {
    throw new Error("seedBucket start time must be less than or equal to desired oldest bucket start -- something is wrong the algorithm")
  }
  if (desiredOldestBucketStartMillis % bucketWidthMillis !== 0) {
    throw new Error("oldestStart must be modulo 0 bucketWidthMillis")
  }
  if (desiredNewestBucketStartMillis % bucketWidthMillis !== 0) {
    throw new Error("newestStart must be modulo 0 bucketWidthMillis")
  }
  if (desiredOldestBucketStartMillis > desiredNewestBucketStartMillis) {
    throw new Error("desiredOldestBucketStart must be before desiredNewestBucketStart")
  }

  // build a map for O(1) lookup
  const bucketKvs = sparseBuckets.map((b) => [pluckBucketTimestamp(b).getTime(), b] as [number, Bucket])
  const bucketMap = new Map<number, Bucket>(bucketKvs)

  // Must start gap filling at the seed bucket start time
  const gapFillStart = pluckBucketTimestamp(seedBucket)


  const numBuckets = expectedBucketCount({
    oldestBucketStart: gapFillStart,
    newestBucketStart: desiredNewestBucketStart,
    bucketWidthMillis: bucketWidthMillis,
  })

  // fill the gaps between the buckets
  // seedBucket may be before the desired range (used only for gap-filling)
  // or it may be the same as the start of the desired range
  const filledBuckets: Bucket[] = [seedBucket]
  for (let i = 1; i < numBuckets; i++) {
    const ts = gapFillStart.getTime() + i * bucketWidthMillis
    const existing = bucketMap.get(ts)
    if (existing) {
      filledBuckets.push(existing)
    } else {
      const prev = filledBuckets[filledBuckets.length - 1]
      const empty = gapFillConstructor(prev)
      filledBuckets.push(empty)
    }
  }

  // now must filter out the buckets that are before the desired oldest bucket start
  const filteredBuckets = filledBuckets.filter(b => pluckBucketTimestamp(b).getTime() >= desiredOldestBucketStartMillis)

  return filteredBuckets
}


/** Do we need to find the seed bucket to carry data forward? 
 * If there is no data in the database, then yes
 * And if the first bucket returned from the DB query is after the search start, then yes
*/
function needsSeedBucket<B>(
  dbData: B[],
  searchStart: Date,
  pluckBucketTimestamp: (b: B) => Date,
): boolean {
  if (dbData.length === 0) {
    return true
  }
  const firstBucketInQuery = dbData[0]
  const firstBucketInQueryStart = pluckBucketTimestamp(firstBucketInQuery)

  // if the first bucket in the query is after the search start, then we need to find the seed bucket
  return firstBucketInQueryStart.getTime() > searchStart.getTime()
}

async function getSeedBucket<B>(
  dbData: B[],
  searchStart: Date,
  pluckBucketTimestamp: (b: B) => Date,
  getLatestBucketBefore: DbLatestBucketBeforeGetter<B>,
): Promise<Result<B, GetBucketsInRangeError>> {
  const mustGetSeedBucket = needsSeedBucket(dbData, searchStart, pluckBucketTimestamp)
  if (!mustGetSeedBucket) {
    return Ok(dbData[0])
  }
  const seedBucket = await catchToResult<B | null, GetBucketsInRangeError>(getLatestBucketBefore(searchStart), e => ({ type: DB_GET_LATEST_BUCKET_BEFORE_ERROR_TYPE, cause: e }))

  const res = seedBucket.andThen(b => b === null ? Err({ type: DB_GET_LATEST_BUCKET_BEFORE_NULL_ERROR_TYPE }) : Ok(b))

  return res
}

const toZrangeMembers = <Bucket>(pluckBucketTimeStamp: (b: Bucket) => Date) => (buckets: Bucket[]): { score: number, value: Bucket }[] => {
  return buckets.map((b) => ({
    score: pluckBucketTimeStamp(b).getTime(),
    value: b,
  }))
}

/** Check if the buckets are sorted in ascending order and have no duplicates*/
const isSortedAscending = <T>(pluckTimestamp: (t: T) => Date) => (buckets: T[]): boolean => {
  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1]
    const curr = buckets[i]
    if (pluckTimestamp(prev).getTime() >= pluckTimestamp(curr).getTime()) {
      return false
    }
  }

  return true
}

const assertSortedAscending = <T>(pluckTimestamp: (t: T) => Date) => (buckets: T[]): T[] => {
  if (!isSortedAscending(pluckTimestamp)(buckets)) {
    throw new Error("buckets are not sorted")
  }
  return buckets
}

async function getRangeFromDbAndSetToCache<EntityKey, Bucket>(
  cache: ICache,
  cacheKeyNamespace: string,
  entityKey: EntityKey,
  rangeQuery: DbRangeGetter<Bucket>,
  getLatestBucketBefore: DbLatestBucketBeforeGetter<Bucket>,
  pluckBucketTimestamp: (b: Bucket) => Date,
  gapFillConstructor: (prev: Bucket) => Bucket,

  bucketWidthMillis: number,
  // desired oldest bucket start
  desiredOldestBucketStart: Date,
  // desired newest bucket start
  desiredNewestBucketStart: Date,
): Promise<Result<Bucket[], GetBucketsInRangeError>> {
  const desiredNewestBucketEndExclusive = new Date(desiredNewestBucketStart.getTime() + bucketWidthMillis)

  // sanitize the query result to ensure it is sorted
  // and throw, since this is a problem with the SQL
  const querySanitized = rangeQuery(desiredOldestBucketStart, desiredNewestBucketEndExclusive).then(assertSortedAscending(pluckBucketTimestamp))

  // query from inclusive start to exclusive end
  const rangeFromDbResult = await catchToResult<Bucket[], GetBucketsInRangeError>(querySanitized, e => ({ type: RANGE_FROM_DB_ERROR_TYPE, cause: e }))

  // get the seed bucket
  // it will either be the first bucket in the db query
  // or the latest bucket found in the db before the desired oldest bucket start
  const seedBucketResult = await andThenAsync(rangeFromDbResult, (bs) => getSeedBucket(bs, desiredOldestBucketStart, pluckBucketTimestamp, getLatestBucketBefore))

  // must fill gaps in the result
  const filledBuckets = Result.all(
    seedBucketResult,
    rangeFromDbResult,
  ).map(([seedBucket, rangeFromDb]) => fillGapsInRange({
    pluckBucketTimestamp,
    desiredOldestBucketStart,
    desiredNewestBucketStart,
    bucketWidthMillis,
    gapFillConstructor,
    seedBucket,
    sparseBuckets: rangeFromDb,
  }))


  const cacheKey = rangeZsetKey(cacheKeyNamespace, entityKey, bucketWidthMillis)

  const members = filledBuckets.map(toZrangeMembers(pluckBucketTimestamp))


  // fire and forget imperative code
  if (members.ok) {
    // Remove existing entries in this range first to avoid duplicates
    // (Redis zsets are unique by member, not score - different bucket objects with same timestamp would duplicate)
    const minScore = desiredOldestBucketStart.getTime()
    const maxScore = desiredNewestBucketEndExclusive.getTime() - 1 // exclusive end
    const ms = members.val
    cache.zreplaceRange(cacheKey, minScore, maxScore, ms).catch((e) => {
      console.error(`Error setting hourly buckets for ${cacheKey}:`, e)
    })
  }

  return filledBuckets
}

function rangeZsetKey<EntityKey>(cacheKeyNamespace: string, entityKey: EntityKey, bucketWidthMills: number): string {
  return `rangedLookup:ns-${cacheKeyNamespace}:entity-${entityKey}:bucketWidthMillis-${bucketWidthMills}`
}

async function getFromCache<EntityKey, Bucket>(
  cacheKeyNamespace: string,
  bucketWidthMills: number,
  entityKey: EntityKey,
  startOfFirstBucket: Date,
  startOfLastClosedBucket: Date,
  cache: ICache,
): Promise<Result<Bucket[], GetBucketsInRangeError>> {
  const cacheKey = rangeZsetKey(cacheKeyNamespace, entityKey, bucketWidthMills)
  const result = await catchToResult<Bucket[], GetBucketsInRangeError>(cache.zrange<Bucket>(cacheKey, startOfFirstBucket.getTime(), startOfLastClosedBucket.getTime(), {
    order: "asc",
  }), e => ({ type: ZRANGE_GET_ERROR_TYPE, cause: e }))
  return result
}

export type ExpectedBucketCountParams = {
  oldestBucketStart: Date
  newestBucketStart: Date
  bucketWidthMillis: number
}
/** Calculate the expected number of buckets in a range
 *
 * If:
 * - startOfFirstBucket = 12:00
 * - startOfLastClosedBucket = 13:00
 * - widthSeconds = 3600
 *
 * Then:
 * - expectedBucketCount = 2 ([12:00, 13:00])
 */
export function expectedBucketCount(params: ExpectedBucketCountParams): number {
  const { oldestBucketStart, newestBucketStart, bucketWidthMillis } = params

  const oldestStart = oldestBucketStart.getTime()
  const newestStart = newestBucketStart.getTime()
  if (oldestStart > newestStart) {
    return 0
  }
  return Math.floor((newestStart - oldestStart) / bucketWidthMillis) + 1
}
