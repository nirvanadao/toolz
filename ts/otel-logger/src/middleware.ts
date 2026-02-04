import { Request, Response, NextFunction } from "express"
import winston from "winston"

/**
 * Express middleware configuration.
 */
export interface ExpressMiddlewareConfig {
  /**
   * Logger instance to use.
   */
  logger: winston.Logger

  /**
   * Paths to skip logging (e.g., health checks).
   * @default ["/healthz", "/readyz", "/health", "/ready"]
   */
  skipPaths?: string[]
}

/**
 * Express middleware that attaches a request-scoped logger.
 *
 * This is a minimal wrapper since OpenTelemetry instrumentation handles
 * trace propagation automatically. The middleware just:
 * - Attaches the logger to req.log
 * - Optionally logs request/response
 * - Skips noisy health check paths
 *
 * IMPORTANT: OpenTelemetry Express instrumentation must be active for
 * automatic trace correlation to work. Call initializeOpenTelemetry() first.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { initializeOpenTelemetry, createLogger, createExpressMiddleware } from '@nirvana-tools/otel-logger'
 *
 * // Initialize OpenTelemetry FIRST
 * initializeOpenTelemetry({ serviceName: 'my-service' })
 *
 * // Create logger
 * const logger = createLogger()
 *
 * // Create app and attach middleware
 * const app = express()
 * app.use(createExpressMiddleware({ logger }))
 *
 * app.get('/api/users', (req, res) => {
 *   req.log.info('Fetching users') // Automatically includes trace context!
 *   res.json({ users: [] })
 * })
 * ```
 */
export function createExpressMiddleware(
  config: ExpressMiddlewareConfig,
): (req: Request, res: Response, next: NextFunction) => void {
  const { logger, skipPaths = ["/healthz", "/readyz", "/health", "/ready"] } = config

  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now()

    // Attach logger to request
    // OpenTelemetry Winston instrumentation will automatically inject trace context
    req.log = logger

    // Check if we should skip logging
    const shouldSkip = skipPaths.includes(req.path)

    // Log incoming request
    if (!shouldSkip) {
      logger.info("Request received", {
        method: req.method,
        url: req.originalUrl,
        userAgent: req.get("user-agent"),
        remoteIp: req.ip,
      })
    }

    // Log response on finish
    if (!shouldSkip) {
      res.on("finish", () => {
        const duration = Date.now() - startTime
        const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"

        logger[level]("Request completed", {
          method: req.method,
          url: req.originalUrl,
          status: res.statusCode,
          duration,
          userAgent: req.get("user-agent"),
          remoteIp: req.ip,
        })
      })
    }

    next()
  }
}

/**
 * Augment Express Request type to include logger.
 */
declare global {
  namespace Express {
    interface Request {
      log: winston.Logger
    }
  }
}
