/**
 * @nirvana-tools/otel-logger
 *
 * Production-ready Winston logger with automatic OpenTelemetry trace correlation
 * for Google Cloud Run services and jobs.
 *
 * Features:
 * - Automatic trace/span injection via OpenTelemetry instrumentation
 * - Google Cloud Logging integration via @google-cloud/logging-winston
 * - Separate initialization for services vs jobs (no unnecessary overhead)
 * - Error Reporting integration
 * - Local development mode
 *
 * Quick Start - HTTP Service:
 * ```ts
 * // index.ts - FIRST LINE!
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()  // Service mode: HTTP + Express + Winston
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
 * Quick Start - Job:
 * ```ts
 * // job.ts - FIRST LINE!
 * import { initJob } from '@nirvana-tools/otel-logger'
 * const logger = initJob()  // Job mode: Winston only (no HTTP overhead)
 *
 * // Now import the rest
 * import { processData } from './processor'
 *
 * async function main() {
 *   logger.info('Job started')
 *   await processData()
 *   logger.info('Job completed')
 * }
 * ```
 *
 * Advanced Usage (Full Control):
 * ```ts
 * import { initializeOpenTelemetry, createLogger } from '@nirvana-tools/otel-logger'
 * import express from 'express'
 *
 * // MUST be first
 * initializeOpenTelemetry({ serviceName: 'my-service', workloadType: 'service' })
 *
 * const logger = createLogger()
 * const app = express()
 *
 * app.get('/api', (req, res) => {
 *   logger.info('Hello') // Automatically includes trace context!
 *   res.json({ ok: true })
 * })
 * ```
 */

// Drop-in API (recommended for most users)
export { init, initJob, getLogger, InitConfig } from "./init"

// Advanced API (for full control)
export { createLogger, LoggerConfig } from "./logger"
export { initializeOpenTelemetry, OpenTelemetryConfig, WorkloadType } from "./otel-setup"
export { createJobLogger, JobLoggerConfig } from "./job-logger"

// Re-export winston types for convenience
export type { Logger } from "winston"

// Re-export OpenTelemetry APIs for manual trace propagation
// Users can access these without separate import of @opentelemetry/api
export { trace, context } from "@opentelemetry/api"
export type { Span, SpanContext } from "@opentelemetry/api"
