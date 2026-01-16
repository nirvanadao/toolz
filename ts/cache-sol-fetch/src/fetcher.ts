import { WebCache, Ok } from "@nirvana-tools/webcache"
import { IRpcPool } from "@nirvana-tools/rpc-pooler"
import { AccountInfo, Commitment, Connection, GetProgramAccountsResponse, PublicKey } from "@solana/web3.js"

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
}

export function accountToKey(address: PublicKey, commitment: Commitment): string {
  return `account:${address.toBase58()}:${commitment}`
}

export function manyAccountsToKey(addresses: PublicKey[], commitment: Commitment): string {
  const ss = addresses.map((a) => a.toBase58())
  // stablize the key by sorting the addresses
  const stable = ss.sort().join(",")
  return `accounts:${stable}:${commitment}`
}

export function programAccountsToKey(args: GetProgramAccountsArgs): string {
  const filtersSorted = args.filters.sort((a, b) => a.offset - b.offset)
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
    maxAgeTolerance: number = Infinity,
  ): Promise<GetProgramAccountsResponse> {
    const { programId, filters, commitment } = args
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

    const res = await this.cache.get(key, f, {
      // 10 seconds
      swrThreshold: 10_000,
      // 20 minutes
      ttl: 20 * 60_000,
      maxAgeTolerance,
    })

    return res.unwrap()
  }

  async fetchSingleAccount(
    address: PublicKey,
    commitment: Commitment = "confirmed",
    maxAgeTolerance: number = Infinity,
  ): Promise<AccountInfo<Buffer> | null> {
    const r = (cnx: Connection) => cnx.getAccountInfo(address, commitment)
    const f = () => this.rpcPooler.request(r).then((ai) => Ok(ai))

    const key = accountToKey(address, commitment)

    const res = await this.cache.get(key, f, {
      // 10 seconds
      swrThreshold: 10_000,
      //  10 minutes
      ttl: 10 * 60_000,

      maxAgeTolerance,
    })

    return res.unwrap()
  }

  async fetchManyAccounts(
    addresses: PublicKey[],
    commitment: Commitment = "confirmed",
    maxAgeTolerance: number = Infinity,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const r = (cnx: Connection) => cnx.getMultipleAccountsInfo(addresses, commitment)
    const f = () => this.rpcPooler.request(r).then((ais) => Ok(ais))

    const key = manyAccountsToKey(addresses, commitment)

    const res = await this.cache.get(key, f, {
      // 5 seconds
      swrThreshold: 5_000,
      // 20 minutes
      ttl: 20 * 60_000,
      maxAgeTolerance,
    })

    return res.unwrap()
  }
}
