import { PublicKey } from "@solana/web3.js"
import { IConnectionProvider, PoolConnectionProvider } from "./connection"
import { ExponentialBackoffRpcPool } from "./expoBackoffPool"

type ThingLoadParams = {
  aKey: PublicKey
  bKey: PublicKey
}
class Thing {
  constructor(aData: Buffer, bData: Buffer) {
    console.log("Thing created", aData.toString("hex"), bData.toString("hex"))
  }

  static async loadFromRpc(cnx: IConnectionProvider, params: ThingLoadParams): Promise<Thing> {
    const aPromise = cnx.getAccountInfo(params.aKey)
    const bPromise = cnx.getMultipleAccountsInfo([params.bKey])
    const [a, b] = await Promise.all([aPromise, bPromise])
    if (!a) throw new Error("A not found")
    if (!b[0]) throw new Error("B not found")
    return new Thing(a.data, b[0].data)
  }
}

export async function loadManyThings(): Promise<Thing[]> {
  // make a pool to be shared between all the things
  const pool = new ExponentialBackoffRpcPool({
    urls: ["https://api.mainnet-beta.solana.com", "https://solana-api.projectserum.com", "https://rpc.ankr.com/solana"],
    maxRetries: 3,
    requestTimeoutMs: 5000,
    jitter: true,
    shuffleOnRetry: true,
  })

  // wrap the pool in a connection provider
  // the connection provider imitates web3.Connection but with the pool
  const cnx = new PoolConnectionProvider(pool)

  const thingsParams: ThingLoadParams[] = [
    { aKey: new PublicKey("aaa"), bKey: new PublicKey("bbb") },
    { aKey: new PublicKey("ccc"), bKey: new PublicKey("ddd") },
    { aKey: new PublicKey("eee"), bKey: new PublicKey("fff") },
  ]

  // run the load jobs in parallel for performance
  const thingLoadJobs = thingsParams.map((param) => Thing.loadFromRpc(cnx, param))

  // wait for all the jobs to finish
  // NOTE: Promise.allSettled is used to wait for all the jobs to finish
  // even if some of them fail
  const thingResults = await Promise.allSettled(thingLoadJobs)

  // collect the failed things
  const failedThingSet = new Set<ThingLoadParams>()
  for (const result of thingResults) {
    if (result.status === "rejected") {
      failedThingSet.add(thingsParams[result.reason])
    }
  }

  // if there are failed things, throw an error
  if (failedThingSet.size > 0) {
    throw new Error(
      `Failed to load some things: ${Array.from(failedThingSet)
        .map((param) => param.aKey.toBase58() + "," + param.bKey.toBase58())
        .join(", ")}`,
    )
  }

  // collect the successful things
  const things = thingResults.map((r) => (r.status === "fulfilled" ? r.value : null)).filter((t) => t !== null)

  // sanity
  if (things.length !== thingsParams.length) {
    // this should never happen because of the previous check on failedThingSet
    throw new Error("Failed to load some things")
  }

  return things
}
