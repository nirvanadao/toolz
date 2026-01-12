import { createClient, RedisClientType } from "redis"

export type OnMutexErrorCallback = (
  operation: "checkMutex" | "claimMutex" | "releaseMutex" | "connect",
  context: { key?: string },
  error: unknown,
) => void

export type RedisMutexConfig = {
  url: string
  keyPrefix: string
  /** TTL in seconds. Defaults to 30. */
  ttlSeconds?: number
  /** Called when a Redis operation fails. */
  onError?: OnMutexErrorCallback
}

const DEFAULT_TTL_SECONDS = 30

/**
 * Lua script for safe release: only deletes if the value matches the token.
 * This prevents releasing a lock that was already expired and re-acquired by another process.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`

export type MutexToken = string

/**
 * Dead-simple Redis mutex for pubsub message deduplication.
 *
 * Usage:
 * 1. Call `claimMutex(messageId)` when receiving a message
 * 2. If it returns a token, process the message
 * 3. Call `releaseMutex(messageId, token)` when done
 * 4. If it returns null, another instance is already processing - skip the message
 *
 * The mutex auto-expires after 30 seconds (configurable) to prevent deadlocks.
 */
export class RedisMutex {
  private readonly client: RedisClientType
  private readonly keyPrefix: string
  private readonly ttlSeconds: number
  private readonly onError?: OnMutexErrorCallback
  private isConnected = false
  private connectPromise: Promise<void> | null = null

  constructor(config: RedisMutexConfig) {
    this.keyPrefix = config.keyPrefix
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS
    this.onError = config.onError

    this.client = createClient({
      url: config.url,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries >= 3) {
            return new Error("Max reconnection attempts reached")
          }
          return Math.min(100 * Math.pow(2, retries), 3000)
        },
      },
    })

    this.client.on("error", (err) => {
      console.error("RedisMutex client error:", err)
      this.isConnected = false
    })

    this.client.on("connect", () => {
      this.isConnected = true
    })

    this.client.on("end", () => {
      this.isConnected = false
    })
  }

  private async ensureConnected(): Promise<void> {
    if (this.isConnected) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = (async () => {
      try {
        if (!this.client.isOpen) {
          await this.client.connect()
          this.isConnected = true
        }
      } catch (error) {
        this.onError?.("connect", {}, error)
        throw error
      } finally {
        this.connectPromise = null
      }
    })()

    return this.connectPromise
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}:${key}`
  }

  private generateToken(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  /**
   * Check if a mutex is currently held (i.e., message is in-flight).
   * Returns true if the mutex is held, false if it's free.
   * Returns false on error (fail-open).
   */
  async checkMutex(key: string): Promise<boolean> {
    try {
      await this.ensureConnected()
      const result = await this.client.exists(this.fullKey(key))
      return result === 1
    } catch (error) {
      this.onError?.("checkMutex", { key }, error)
      return false
    }
  }

  /**
   * Attempt to claim a mutex atomically.
   * Returns a token if successful, or null if already claimed.
   * Returns null on error (fail-safe: don't process if unsure).
   *
   * The token must be passed to `releaseMutex` to release the lock.
   */
  async claimMutex(key: string): Promise<MutexToken | null> {
    try {
      await this.ensureConnected()
      const token = this.generateToken()
      const result = await this.client.set(this.fullKey(key), token, {
        NX: true,
        EX: this.ttlSeconds,
      })
      return result === "OK" ? token : null
    } catch (error) {
      this.onError?.("claimMutex", { key }, error)
      return null
    }
  }

  /**
   * Release a mutex. Only succeeds if the token matches (i.e., you own the lock).
   * Returns true if released, false if the lock was already expired or owned by another.
   * Returns false on error (lock will auto-expire via TTL).
   */
  async releaseMutex(key: string, token: MutexToken): Promise<boolean> {
    try {
      await this.ensureConnected()
      const result = await this.client.eval(RELEASE_SCRIPT, {
        keys: [this.fullKey(key)],
        arguments: [token],
      })
      return result === 1
    } catch (error) {
      this.onError?.("releaseMutex", { key }, error)
      return false
    }
  }

  /**
   * Gracefully close the Redis connection.
   */
  async disconnect(): Promise<void> {
    try {
      if (this.client.isOpen) {
        await this.client.quit()
      }
    } catch {
      await this.client.disconnect()
    }
  }
}
