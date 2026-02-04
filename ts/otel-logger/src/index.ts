/**
 * @nirvana-tools/otel-logger
 *
 * Production-ready Winston logger with automatic OpenTelemetry trace correlation
 * for Google Cloud Run services and jobs.
 *
 * Features:
 * - Automatic trace/span injection via OpenTelemetry instrumentation
 * - Google Cloud Logging integration via @google-cloud/logging-winston
 * - Works for both Cloud Run services (HTTP) and jobs
 * - Error Reporting integration
 * - Local development mode
 *
 * Drop-In Usage (Recommended - One Line!):
 * ```ts
 * // index.ts - FIRST LINE!
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()
 *
 * // Now import the rest
 * import express from 'express'
 *
 * const app = express()
 * app.get('/api', (req, res) => {
 *   logger.info('Hello') // Automatically includes trace context!
 *   res.json({ ok: true })
 * })
 * ```
 *
 * Advanced Usage (Full Control):
 * ```ts
 * import { initializeOpenTelemetry, createLogger, createExpressMiddleware } from '@nirvana-tools/otel-logger'
 * import express from 'express'
 *
 * // MUST be first
 * initializeOpenTelemetry({ serviceName: 'my-service' })
 *
 * const logger = createLogger()
 * const app = express()
 *
 * app.use(createExpressMiddleware({ logger }))
 *
 * app.get('/api', (req, res) => {
 *   req.log.info('Hello') // Automatically includes trace context!
 *   res.json({ ok: true })
 * })
 * ```
 */

// Drop-in API (recommended for most users)
export { init, getLogger, InitConfig } from "./init"

// Advanced API (for full control)
export { createLogger, LoggerConfig } from "./logger"
export { initializeOpenTelemetry, OpenTelemetryConfig } from "./otel-setup"
export { createExpressMiddleware, ExpressMiddlewareConfig } from "./middleware"
export { createJobLogger, JobLoggerConfig } from "./job-logger"

// Re-export winston types for convenience
export type { Logger } from "winston"
