import express, { Request, Response, Express } from "express"
import * as http from "http"
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

/** Pub/Sub push message structure */
export type PushMessage = {
  data: string // base64-encoded
  attributes?: Record<string, string>
  messageId: string
  publishTime?: string
}

/** POST body from Pub/Sub push subscription */
export type PushRequestBody = {
  message?: PushMessage
  subscription?: string
}

/** Decode raw push message to your domain type */
export type DecodeFn<T> = (msg: PushMessage) => T | Promise<T>

/** Handle decoded message */
export type HandleFn<T> = (
  decoded: T,
  context: { raw: PushMessage; rawBuffer: Buffer },
) => Promise<void> | void

/** Path configuration for the server endpoints */
export type PathConfig = {
  /** Path for Pub/Sub push messages (default: "/pubsub") */
  push?: string
  /** Path for health check probe (default: "/healthz") */
  health?: string
}

export type PubSubReceiverServerArgs<T> = {
  decode: DecodeFn<T>
  handle: HandleFn<T>
  healthCheck: () => Promise<boolean>
  logger: CloudRunLogger
  /** Optional token for endpoint verification (?token=...) */
  verificationToken?: string
  /** Configure endpoint paths */
  paths?: PathConfig
}

const DEFAULT_PATHS: Required<PathConfig> = {
  push: "/pubsub",
  health: "/healthz",
}

export class PubSubReceiverServer<T> {
  private app: Express
  private server: http.Server | null = null
  private logger: CloudRunLogger
  private options: PubSubReceiverServerArgs<T>
  private paths: Required<PathConfig>

  constructor(options: PubSubReceiverServerArgs<T>) {
    this.options = options
    this.logger = options.logger
    this.paths = { ...DEFAULT_PATHS, ...options.paths }
    this.app = express()
    this.app.use(express.json())
  }

  start(port: number): Promise<void> {
    const { push, health } = this.paths

    this.app.post(push, this.handlePush)
    this.app.get(health, this.handleHealth)

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        this.logger.info("Server started", { port, paths: this.paths })
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve()

      this.server.close((err) => {
        if (err) {
          this.logger.error("Error shutting down", {
            error: err.message,
          })
          return reject(err)
        }
        this.logger.info("Server stopped")
        this.server = null
        resolve()
      })
    })
  }

  private handleHealth = async (_req: Request, res: Response) => {
    try {
      const healthy = await this.options.healthCheck()
      res.status(healthy ? 200 : 503).send(healthy ? "OK" : "Unhealthy")
    } catch (error) {
      this.logger.error("Health check failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      res.status(503).send("Unhealthy")
    }
  }

  private handlePush = async (req: Request<{}, {}, PushRequestBody>, res: Response) => {
    const subscription = req.body?.subscription
    const message = req.body?.message
    const messageId = message?.messageId

    // Verify token if configured
    if (this.options.verificationToken && req.query.token !== this.options.verificationToken) {
      this.logger.warn("Unauthorized request", { subscription })
      return res.status(401).send("Invalid token")
    }

    if (!message?.data) {
      this.logger.debug("Empty message received, acking", { subscription, messageId })
      return res.status(204).end()
    }

    try {
      const rawBuffer = Buffer.from(message.data, "base64")
      const decoded = await this.options.decode(message)
      await this.options.handle(decoded, { raw: message, rawBuffer })

      this.logger.info("Message processed", { messageId, subscription })
      res.status(204).end()
    } catch (error) {
      this.logger.error("Failed to process message", {
        messageId,
        subscription,
        error: error instanceof Error ? error.message : String(error),
      })
      res.status(500).send("Internal Server Error")
    }
  }
}

/** Helper to decode base64 message data to string */
export function decodeMessageData(message: PushMessage): string {
  return Buffer.from(message.data, "base64").toString("utf-8")
}
