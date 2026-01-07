import express, { Express, Request, Response } from "express"
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
import { HandleHeliusWebhookFn, HeliusWebhookPayload } from "./types"

export type HeliusWebhookServerArgs = {
  /** Port to listen on */
  port: number
  /** Handler function for processing webhook payloads */
  handler: HandleHeliusWebhookFn
  /** Logger instance */
  logger: CloudRunLogger
  /** Authorization token to validate requests */
  authToken: string
  /** Path for webhook endpoint (default: /webhook) */
  webhookPath?: string
  /** Path for health check endpoint (default: /health) */
  healthPath?: string
}

export class HeliusWebhookServer {
  private app: Express
  private server: ReturnType<Express["listen"]> | null = null
  private port: number
  private handler: HandleHeliusWebhookFn
  private logger: CloudRunLogger
  private authToken: string
  private webhookPath: string
  private healthPath: string

  constructor(args: HeliusWebhookServerArgs) {
    this.port = args.port
    this.handler = args.handler
    this.logger = args.logger.withLabels({ component: "helius-webhook-server" })
    this.authToken = args.authToken
    this.webhookPath = args.webhookPath ?? "/webhook"
    this.healthPath = args.healthPath ?? "/health"

    this.app = express()
    this.app.use(express.json({ limit: "10mb" }))
    this.setupRoutes()
  }

  private setupRoutes(): void {
    this.app.get(this.healthPath, (_req: Request, res: Response) => {
      res.status(200).json({ status: "ok" })
    })

    this.app.post(this.webhookPath, async (req: Request, res: Response) => {
      const requestLogger = this.logger.withFields({
        path: req.path,
        method: req.method,
      })

      // Validate auth token
      const authHeader = req.headers.authorization
      if (!authHeader || authHeader !== this.authToken) {
        requestLogger.warn("Unauthorized request", {
          hasAuthHeader: !!authHeader,
        })
        res.status(401).json({ error: "Unauthorized" })
        return
      }

      const body = req.body
      if (!body) {
        requestLogger.warn("Empty request body")
        res.status(400).json({ error: "Empty body" })
        return
      }

      // Helius sends an array of events
      const payloads: HeliusWebhookPayload[] = Array.isArray(body) ? body : [body]

      requestLogger.debug("Received webhook", {
        eventCount: payloads.length,
        signatures: payloads.map((p) => p.signature),
      })

      try {
        await this.handler(payloads)
        requestLogger.info("Processed webhook", {
          eventCount: payloads.length,
        })
        res.status(200).json({ success: true })
      } catch (error) {
        requestLogger.error("Failed to process webhook", {
          error: error instanceof Error ? error.message : String(error),
          eventCount: payloads.length,
        })
        res.status(500).json({ error: "Processing failed" })
      }
    })
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        this.logger.info("Helius webhook server started", {
          port: this.port,
          webhookPath: this.webhookPath,
          healthPath: this.healthPath,
        })
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve()
        return
      }
      this.server.close((err) => {
        if (err) {
          this.logger.error("Error stopping server", {
            error: err.message,
          })
          reject(err)
        } else {
          this.logger.info("Helius webhook server stopped")
          resolve()
        }
      })
    })
  }
}
