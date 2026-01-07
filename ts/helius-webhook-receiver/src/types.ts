/** Handler function signature for processing webhook payloads */
export type HandleHeliusWebhookFn = (data: HeliusWebhookPayload[]) => Promise<void>

/** Helius webhook payload - array of transaction events */
export type HeliusWebhookPayload = {
  /** Transaction signature */
  signature: string
  /** Slot number */
  slot: number
  /** Block time (unix timestamp) */
  blockTime: number
  /** Transaction type */
  type: string
  /** Source of the transaction */
  source: string
  /** Fee payer account */
  feePayer: string
  /** Transaction fee in lamports */
  fee: number
  /** Native SOL transfers */
  nativeTransfers?: NativeTransfer[]
  /** SPL token transfers */
  tokenTransfers?: TokenTransfer[]
  /** Account data changes */
  accountData?: AccountData[]
  /** Raw transaction data (if enabled) */
  raw?: unknown
}

export type NativeTransfer = {
  fromUserAccount: string
  toUserAccount: string
  amount: number
}

export type TokenTransfer = {
  fromUserAccount: string
  toUserAccount: string
  fromTokenAccount: string
  toTokenAccount: string
  tokenAmount: number
  mint: string
}

export type AccountData = {
  account: string
  nativeBalanceChange: number
  tokenBalanceChanges: TokenBalanceChange[]
}

export type TokenBalanceChange = {
  userAccount: string
  tokenAccount: string
  mint: string
  rawTokenAmount: {
    tokenAmount: string
    decimals: number
  }
}
