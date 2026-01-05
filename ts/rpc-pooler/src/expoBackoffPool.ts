import { Connection, Commitment } from "@solana/web3.js"
import { IRpcPool, NoRetryError, RpcPoolOptions, RpcRequest } from "./types"

/**
 * A utility promise for creating delays.
 * @param ms - The number of milliseconds to wait.
 */
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wraps a promise with a timeout.
 * @param promise - The promise to wrap.
 * @param ms - The timeout duration in milliseconds.
 * @param timeoutMessage - The error message to throw on timeout.
 * @returns The result of the promise if it resolves within the time limit.
 * @throws An error if the promise times out.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage?: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>

  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage ?? `Promise timed out after ${ms}ms`))
    }, ms)
  })

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

/**
 * Shuffles an array using the Fisher-Yates algorithm.
 * Creates a new array to avoid mutating the original.
 * @param array The array to shuffle.
 * @returns A new array with the elements shuffled.
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

/**
 * Calculates exponential backoff delay.
 * @param attempt - The current retry attempt number (0-indexed).
 * @param baseDelayMs - The base delay.
 * @param maxDelayMs - The maximum possible delay.
 * @param jitter - Whether to apply random jitter to the delay.
 * @returns The calculated delay in milliseconds.
 */
export function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: boolean): number {
  const exponentialDelay = Math.pow(2, attempt) * baseDelayMs
  const delay = Math.min(exponentialDelay, maxDelayMs)

  if (jitter) {
    // Apply jitter to prevent thundering herd problem: +/- 50% of the delay
    return delay * (0.5 + Math.random())
  }
  return delay
}

/** Solana JSON-RPC error codes that indicate permanent failures (don't retry) */
const NON_RETRYABLE_RPC_CODES = new Set([
  -32600, // Invalid request
  -32601, // Method not found
  -32602, // Invalid params
])

/**
 * Check if an RPC error should be retried.
 * By default, retry everything except obvious permanent failures.
 */
export function isRetryableRpcError(error: unknown): boolean {
  if (error instanceof NoRetryError) {
    return false
  }

  if (error && typeof error === "object") {
    // Check for Solana JSON-RPC error codes
    const code = (error as { code?: number }).code
    if (code !== undefined && NON_RETRYABLE_RPC_CODES.has(code)) {
      return false
    }
  }
  return true
}

/**
 * Options specific to the exponential backoff pool.
 */
export interface ExponentialBackoffPoolOptions extends RpcPoolOptions {
  /** Maximum number of retry cycles through all URLs. Default: 3 */
  maxRetries?: number
  /** Base delay for exponential backoff in milliseconds. Default: 500ms */
  baseDelayMs?: number
  /** Maximum delay between retry cycles in milliseconds. Default: 30_000ms */
  maxDelayMs?: number
  /** Whether to add jitter to backoff delays. Default: true */
  jitter?: boolean
  /** Whether to shuffle URL order on each retry cycle. Default: false */
  shuffleOnRetry?: boolean
}

type UrlStats = {
  attempts: number
  successes: number
  failures: number
  totalResponseTime: number
}

type AllStats = {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  urlStats: Record<string, UrlStats & { averageResponseTime?: number }>
}

/**
 * An RPC pool that retries requests across multiple endpoints with an
 * exponential backoff strategy. It cycles through all URLs, and if all
 * fail, it waits for an increasing amount of time before trying again.
 */
export class ExponentialBackoffRpcPool implements IRpcPool {
  private urls: string[]
  private readonly options: Required<Omit<ExponentialBackoffPoolOptions, "urls" | "onError" | "onDebug">>
  private readonly onError?: ExponentialBackoffPoolOptions["onError"]
  private readonly onDebug?: ExponentialBackoffPoolOptions["onDebug"]
  private readonly connections: Map<string, Connection> = new Map()

  private stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    urlStats: new Map<string, UrlStats>(),
  }

  constructor(options: ExponentialBackoffPoolOptions) {
    if (!options.urls || options.urls.length === 0) {
      throw new Error("RPC pool must be initialized with at least one URL.")
    }
    this.urls = [...options.urls]
    this.onError = options.onError
    this.onDebug = options.onDebug

    // Set default values for all options
    this.options = {
      defaultCommitment: options.defaultCommitment || "confirmed",
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      maxRetries: options.maxRetries ?? 3,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      jitter: options.jitter ?? true,
      shuffleOnRetry: options.shuffleOnRetry ?? false,
    }

    this.urls.forEach((url) => this._initUrlStats(url))
  }

  get defaultCommitment(): Commitment {
    return this.options.defaultCommitment
  }

  /**
   * Executes an RPC request, applying the pool's retry and backoff strategy.
   */
  async request<T>(request: RpcRequest<T>, commitment?: Commitment): Promise<T> {
    this.stats.totalRequests++
    const errors: { url: string; error: unknown }[] = []
    let totalAttempts = 0
    const effectiveCommitment = commitment ?? this.options.defaultCommitment

    for (let cycle = 0; cycle <= this.options.maxRetries; cycle++) {
      if (cycle > 0) {
        const backoffDelay = calculateBackoff(
          cycle - 1,
          this.options.baseDelayMs,
          this.options.maxDelayMs,
          this.options.jitter,
        )
        this.onDebug?.(`All URLs failed in cycle ${cycle}. Backing off for ${backoffDelay.toFixed(0)}ms.`)
        await sleep(backoffDelay)
      }

      const urlsToTry = this.options.shuffleOnRetry ? shuffleArray(this.urls) : this.urls

      for (const url of urlsToTry) {
        totalAttempts++
        try {
          this.onDebug?.(`Attempt #${totalAttempts} (Cycle ${cycle + 1}) to ${url}`)
          const result = await this._executeSingleRequest(url, request, effectiveCommitment)
          this.stats.successfulRequests++
          return result
        } catch (error) {
          errors.push({ url, error })
          this.onError?.(url, error, totalAttempts)

          if (!isRetryableRpcError(error)) {
            this.onDebug?.(`Non-retryable error from ${url}. Failing fast. Error: ${error}`)
            this.stats.failedRequests++
            throw error
          }
        }
      }
    }

    this.stats.failedRequests++
    throw new Error(
      `Request failed after ${this.options.maxRetries + 1} cycles and ${totalAttempts} attempts. ` +
        `Errors: ${this._summarizeErrors(errors)}`,
    )
  }

  /**
   * Gets or creates a cached connection for the given URL and commitment.
   */
  private _getConnection(url: string, commitment: Commitment): Connection {
    const cacheKey = `${url}:${commitment}`
    let connection = this.connections.get(cacheKey)
    if (!connection) {
      connection = new Connection(url, commitment)
      this.connections.set(cacheKey, connection)
    }
    return connection
  }

  /**
   * Executes a single RPC request to a specific URL with a timeout.
   */
  private async _executeSingleRequest<T>(url: string, request: RpcRequest<T>, commitment: Commitment): Promise<T> {
    const urlStat = this.stats.urlStats.get(url)!
    urlStat.attempts++
    const startTime = performance.now()

    try {
      const connection = this._getConnection(url, commitment)
      const result = await withTimeout(
        request(connection),
        this.options.requestTimeoutMs,
        `Request to ${url} timed out`,
      )

      const duration = performance.now() - startTime
      urlStat.successes++
      urlStat.totalResponseTime += duration
      this.onDebug?.(`Request to ${url} succeeded in ${duration.toFixed(0)}ms.`)
      return result
    } catch (error) {
      urlStat.failures++
      this.onDebug?.(`Request to ${url} failed. Error: ${error}`)
      throw error // Re-throw to be caught by the main request loop
    }
  }

  private _summarizeErrors(errors: { url: string; error: unknown }[]): string {
    const errorCounts = errors.reduce((acc, { url, error }) => {
      const key = `${url}: ${String(error)}`
      acc.set(key, (acc.get(key) || 0) + 1)
      return acc
    }, new Map<string, number>())

    return Array.from(errorCounts.entries())
      .map(([msg, count]) => (count > 1 ? `${msg} (${count}x)` : msg))
      .join("; ")
  }

  private _initUrlStats(url: string): void {
    if (!this.stats.urlStats.has(url)) {
      this.stats.urlStats.set(url, {
        attempts: 0,
        successes: 0,
        failures: 0,
        totalResponseTime: 0,
      })
    }
  }

  /**
   * Returns a copy of the current list of RPC URLs.
   */
  getUrls(): string[] {
    return [...this.urls]
  }

  /**
   * Returns a snapshot of the current request statistics.
   */
  getStats(): AllStats {
    const urlStatsWithAvg: AllStats["urlStats"] = {}
    for (const [url, stats] of this.stats.urlStats.entries()) {
      urlStatsWithAvg[url] = {
        ...stats,
        averageResponseTime: stats.successes > 0 ? stats.totalResponseTime / stats.successes : undefined,
      }
    }

    return {
      totalRequests: this.stats.totalRequests,
      successfulRequests: this.stats.successfulRequests,
      failedRequests: this.stats.failedRequests,
      urlStats: urlStatsWithAvg,
    }
  }
}
