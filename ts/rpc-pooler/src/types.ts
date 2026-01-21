import { Connection, Commitment } from "@solana/web3.js"

/**
 * Function that makes a request using a Connection
 */
export type RpcRequest<T> = (connection: Connection) => Promise<T>

/**
 * Options for RPC pool implementations
 */
export interface RpcPoolOptions {
  /** RPC endpoint URLs */
  urls: string[]

  /** Default commitment level */
  defaultCommitment?: Commitment

  /** Callback for errors */
  onError?: (url: string, error: unknown, attemptNumber: number) => void

  /** Callback for debug messages */
  onDebug?: (message: string) => void

  /** Timeout per request in milliseconds */
  requestTimeoutMs?: number
}

/**
 * An error that signals to the RPC pool that it should NOT retry.
 * Use this for permanent failures like simulation errors or business logic failures.
 */
export class NoRetryError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "NoRetryError"
  }
}

/**
 * Error thrown when a request is aborted via AbortSignal.
 */
export class AbortError extends Error {
  constructor(message = "Request was aborted") {
    super(message)
    this.name = "AbortError"
  }
}

/**
 * Interface for RPC pool implementations
 */
export interface IRpcPool {
  defaultCommitment: Commitment

  /**
   * Execute a request using the RPC pool strategy
   * @param request Function that takes a Connection and returns a Promise
   * @param commitment Optional commitment level override for this request
   * @param signal Optional AbortSignal to cancel the request
   * @returns The result from the first successful request
   * @throws Error if all attempts fail
   * @throws AbortError if the request is aborted via signal
   */
  request<T>(request: RpcRequest<T>, commitment?: Commitment, signal?: AbortSignal): Promise<T>

  /**
   * Get the list of RPC URLs in the pool
   */
  getUrls(): string[]

  /**
   * Get statistics about the pool performance (optional)
   */
  getStats?(): {
    totalRequests: number
    successfulRequests: number
    failedRequests: number
    urlStats: Record<
      string,
      {
        attempts: number
        successes: number
        failures: number
        averageResponseTime?: number
      }
    >
  }
}
