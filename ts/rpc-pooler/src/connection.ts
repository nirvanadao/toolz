import {
  Connection,
  Commitment,
  PublicKey,
  AccountInfo,
  GetAccountInfoConfig,
  GetMultipleAccountsConfig,
  TransactionConfirmationStrategy,
  GetLatestBlockhashConfig,
  BlockhashWithExpiryBlockHeight,
  RpcResponseAndContext,
  SignatureResult,
  GetVersionedTransactionConfig,
  VersionedTransactionResponse,
} from "@solana/web3.js"
import { IRpcPool } from "./types"

/** Basic interface that implements the parts of a Connection that we use */
export interface IConnectionProvider {
  defaultCommitment: Commitment

  getAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<AccountInfo<Buffer> | null>
  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
  ): Promise<(AccountInfo<Buffer> | null)[]>
  getBlockHeight(commitment?: Commitment): Promise<number>
  /**
   * Fetch the latest blockhash from the cluster
   * @return {Promise<BlockhashWithExpiryBlockHeight>}
   */
  getLatestBlockhash(
    commitmentOrConfig?: Commitment | GetLatestBlockhashConfig,
  ): Promise<BlockhashWithExpiryBlockHeight>

  confirmTransaction(
    strategy: TransactionConfirmationStrategy,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>>

  getTransaction(
    signature: string,
    rawConfig: GetVersionedTransactionConfig,
  ): Promise<VersionedTransactionResponse | null>
}

/** Connection provider that uses an RPC pool */
export class PoolConnectionProvider<P extends IRpcPool> implements IConnectionProvider {
  readonly defaultCommitment: Commitment

  constructor(private readonly pool: P) {
    this.defaultCommitment = pool.defaultCommitment
  }

  getAccountInfo(
    publicKey: PublicKey,
    commitmentOrConfig?: Commitment | GetAccountInfoConfig,
  ): Promise<AccountInfo<Buffer> | null> {
    return this.pool.request((connection: Connection) => connection.getAccountInfo(publicKey, commitmentOrConfig))
  }

  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitmentOrConfig?: Commitment | GetMultipleAccountsConfig,
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.pool.request((connection: Connection) =>
      connection.getMultipleAccountsInfo(publicKeys, commitmentOrConfig),
    )
  }

  getBlockHeight(commitment?: Commitment): Promise<number> {
    return this.pool.request((connection: Connection) => connection.getBlockHeight(commitment))
  }

  getLatestBlockhash(
    commitmentOrConfig?: Commitment | GetLatestBlockhashConfig,
  ): Promise<BlockhashWithExpiryBlockHeight> {
    return this.pool.request((connection: Connection) => connection.getLatestBlockhash(commitmentOrConfig))
  }

  confirmTransaction(
    strategy: TransactionConfirmationStrategy,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<SignatureResult>> {
    return this.pool.request((connection: Connection) => connection.confirmTransaction(strategy, commitment))
  }

  getTransaction(
    signature: string,
    rawConfig: GetVersionedTransactionConfig,
  ): Promise<VersionedTransactionResponse | null> {
    return this.pool.request((connection: Connection) => connection.getTransaction(signature, rawConfig))
  }
}
