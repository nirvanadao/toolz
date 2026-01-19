import { WebCache, Ok } from "@nirvana-tools/webcache"
import { IRpcPool } from "@nirvana-tools/rpc-pooler"
import { AccountInfo, Commitment, Connection, GetProgramAccountsResponse, PublicKey } from "@solana/web3.js"

export type CacheOptions = {
  swrThreshold?: number
  ttl?: number
  maxAgeTolerance?: number
}

const DEFAULT_SWR_THRESHOLD = 10_000
const DEFAULT_TTL = 30 * 60_000
const DEFAULT_MAX_AGE_TOLERANCE = Infinity

const swrThreshold = (o?: CacheOptions) => o?.swrThreshold ?? DEFAULT_SWR_THRESHOLD
const ttl = (o?: CacheOptions) => o?.ttl ?? DEFAULT_TTL
const maxAgeTolerance = (o?: CacheOptions) => o?.maxAgeTolerance ?? DEFAULT_MAX_AGE_TOLERANCE

const withDefaults = (o?: CacheOptions) => ({
  swrThreshold: swrThreshold(o),
  ttl: ttl(o),
  maxAgeTolerance: maxAgeTolerance(o),
})

export type CacheSolFetchOptions = {
  cache: WebCache
  rpcPooler: IRpcPool
}

export type MemcmpFilter = {
  offset: number
  b64bytes: string
}

export type GetProgramAccountsArgs = {
  programId: PublicKey
  filters: MemcmpFilter[]
  commitment: Commitment
  cacheOptions?: CacheOptions
}

export type FetchSingleAccountArgs = {
  address: PublicKey
  commitment: Commitment
  cacheOptions?: CacheOptions
}

export type FetchManyAccountsArgs = {
  addresses: PublicKey[]
  commitment: Commitment
  cacheOptions?: CacheOptions
}

export function accountToKey(address: PublicKey, commitment: Commitment): string {
  return `account:${address.toBase58()}:${commitment}`
}

export function manyAccountsToKey(addresses: PublicKey[], commitment: Commitment): string {
  const ss = addresses.map((a) => a.toBase58())
  // stabilize the key by sorting the addresses
  const stable = ss.sort().join(",")
  return `accounts:${stable}:${commitment}`
}

export function programAccountsToKey(args: GetProgramAccountsArgs): string {
  const filtersSorted = [...args.filters].sort((a, b) => a.offset - b.offset)
  const filtersString = filtersSorted.map((f) => `${f.offset}:${f.b64bytes}`).join(",")
  return `program-accounts:${args.programId.toBase58()}:filters-${filtersString}:commitment-${args.commitment}`
}

export class SolFetchCached {
  private readonly cache: WebCache
  private readonly rpcPooler: IRpcPool

  constructor(options: CacheSolFetchOptions) {
    this.cache = options.cache
    this.rpcPooler = options.rpcPooler
  }

  async fetchProgramAccounts(
    args: GetProgramAccountsArgs,
  ): Promise<GetProgramAccountsResponse> {
    const { programId, filters, commitment, cacheOptions } = args

    const r = (cnx: Connection) =>
      cnx.getProgramAccounts(programId, {
        commitment,
        filters: filters.map((f) => ({
          memcmp: {
            offset: f.offset,
            bytes: f.b64bytes,
            encoding: "base64",
          },
        })),
      })

    const f = () => this.rpcPooler.request(r).then((r) => Ok(r))

    const key = programAccountsToKey(args)

    const res = await this.cache.get(key, f, withDefaults(cacheOptions))

    return res.unwrap()
  }

  async fetchSingleAccount(
    args: FetchSingleAccountArgs,
  ): Promise<AccountInfo<Buffer> | null> {
    const { address, commitment, cacheOptions } = args
    const r = (cnx: Connection) => cnx.getAccountInfo(address, commitment)
    const f = () => this.rpcPooler.request(r).then((ai) => Ok(ai))

    const key = accountToKey(address, commitment)

    const res = await this.cache.get(key, f, withDefaults(cacheOptions))

    return res.unwrap()
  }

  async fetchManyAccounts(
    args: FetchManyAccountsArgs,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const { addresses, commitment, cacheOptions } = args
    const r = (cnx: Connection) => cnx.getMultipleAccountsInfo(addresses, commitment)
    const f = () => this.rpcPooler.request(r).then((ais) => Ok(ais))

    const key = manyAccountsToKey(addresses, commitment)

    const res = await this.cache.get(key, f, withDefaults(cacheOptions))

    return res.unwrap()
  }
}
