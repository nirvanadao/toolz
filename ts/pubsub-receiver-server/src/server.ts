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

export type PubSubReceiverServerArgs<T> = {
  decode: DecodeFn<T>
  handle: HandleFn<T>
  healthCheck: () => Promise<boolean>
  logger: CloudRunLogger
  /** Optional token for endpoint verification (?token=...) */
  verificationToken?: string
}

export class PubSubReceiverServer<T> {
  private app: Express
  private server: http.Server | null = null
  private logger: CloudRunLogger
  private options: PubSubReceiverServerArgs<T>

  constructor(options: PubSubReceiverServerArgs<T>) {
    this.options = options
    this.logger = options.logger
    this.app = express()
    this.app.use(express.json())
  }

  start(port: number, path = "/pubsub"): Promise<void> {
    this.app.post(path, this.handlePush)
    this.app.get("/healthz", this.handleHealth)

    return new Promise((resolve) => {
      this.server = this.app.listen(port, () => {
        this.logger.info("Server started", { port, path })
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
    const healthy = await this.options.healthCheck()
    res.status(healthy ? 200 : 503).send(healthy ? "OK" : "Unhealthy")
  }

  private handlePush = async (req: Request<{}, {}, PushRequestBody>, res: Response) => {
    // Verify token if configured
    if (this.options.verificationToken && req.query.token !== this.options.verificationToken) {
      this.logger.warn("Unauthorized request")
      return res.status(401).send("Invalid token")
    }

    const message = req.body?.message
    if (!message?.data) {
      // Ack empty/malformed messages so Pub/Sub doesn't retry
      return res.status(204).end()
    }

    try {
      const rawBuffer = Buffer.from(message.data, "base64")
      const decoded = await this.options.decode(message)
      await this.options.handle(decoded, { raw: message, rawBuffer })
      res.status(204).end()
    } catch (error) {
      this.logger.error("Failed to process message", {
        messageId: message.messageId,
        error: error instanceof Error ? error.message : String(error),
      })
      // Nack so Pub/Sub retries
      res.status(500).send("Internal Server Error")
    }
  }
}

/** Helper to decode base64 message data to string */
export function decodeMessageData(message: PushMessage): string {
  return Buffer.from(message.data, "base64").toString("utf-8")
}
