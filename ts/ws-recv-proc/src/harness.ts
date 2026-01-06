import express, { Request, Response } from "express"

/**
 * Represents a service that has a lifecycle (start/stop)
 * and can report its readiness state.
 */
export interface IMonitoredService {
  start(): void
  shutdown(): void
  isReady(): boolean
}

// --- Component 3: The Express Harness ---

export class HealthHarness {
  private app = express()
  private port: number
  private service: IMonitoredService

  constructor(port: number, service: IMonitoredService) {
    this.port = port
    this.service = service
    this.setupRoutes()
  }

  private setupRoutes() {
    // Liveness: Is the process running?
    this.app.get("/healthz", (req: Request, res: Response) => {
      res.status(200).send("OK")
    })

    // Readiness: Is the logic actually working (connected)?
    this.app.get("/readyz", (req: Request, res: Response) => {
      if (this.service.isReady()) {
        res.status(200).send("READY")
      } else {
        res.status(503).send("NOT_READY")
      }
    })
  }

  public start() {
    // 1. Start the actual business logic
    this.service.start()

    // 2. Start the HTTP server wrapper
    const server = this.app.listen(this.port, () => {
      console.log(`🏥 Health Harness listening on port ${this.port}`)
    })

    // 3. Handle Graceful Shutdown
    const gracefulShutdown = () => {
      console.log("🛑 SIGTERM/SIGINT received. Shutting down...")
      this.service.shutdown()
      server.close(() => {
        console.log("HTTP server closed.")
        process.exit(0)
      })
    }

    process.on("SIGTERM", gracefulShutdown)
    process.on("SIGINT", gracefulShutdown)
  }
}
