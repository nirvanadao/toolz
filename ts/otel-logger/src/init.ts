import { NodeSDK } from "@opentelemetry/sdk-node"
import winston from "winston"
import { initializeOpenTelemetry } from "./otel-setup"
import { createLogger } from "./logger"
import { createJobLogger } from "./job-logger"

/**
 * Configuration for init() and initJob().
 *
 * Service name and project ID are read from environment variables.
 * No overrides - be explicit by setting env vars.
 */
export interface InitConfig {
  /**
   * Log level.
   * @default process.env.LOG_LEVEL || "info"
   */
  level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"

  /**
   * Additional labels for Cloud Logging.
   */
  labels?: Record<string, string>

  /**
   * Additional instrumentations beyond defaults.
   */
  instrumentations?: any[]
}

let initialized = false
let sdk: NodeSDK | null = null
let logger: winston.Logger | null = null

/**
 * Initialize OpenTelemetry + Winston logger for HTTP services (Cloud Run services).
 *
 * Reads configuration from environment variables:
 * - K_SERVICE (required) - Service name, automatically set by Cloud Run
 * - K_REVISION (optional) - Service version, automatically set by Cloud Run
 * - GOOGLE_CLOUD_PROJECT (optional) - Project ID, auto-detected from metadata server if not set
 * - LOG_LEVEL (optional) - Log level, default "info"
 * - NODE_ENV=development (optional) - Enables local console output
 *
 * Use this for Cloud Run services that handle HTTP requests (Express, Koa, Fastify, etc.).
 * For jobs, use initJob() instead (no HTTP/Express overhead).
 *
 * CRITICAL: Must be called BEFORE any other imports.
 *
 * @example
 * ```typescript
 * // index.ts - Very first line!
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()
 *
 * // Now import the rest
 * import express from 'express'
 *
 * const app = express()
 * app.get('/api', (req, res) => {
 *   logger.info('Request received')  // Automatically includes trace!
 *   res.json({ ok: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Optional: customize log level and labels
 * const logger = init({
 *   level: 'debug',
 *   labels: { team: 'platform', env: 'prod' }
 * })
 * ```
 */
export function init(config?: InitConfig): winston.Logger {
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Initialize OpenTelemetry with service mode (HTTP + Express + Winston)
  // Reads K_SERVICE and K_REVISION from env (validated inside)
  sdk = initializeOpenTelemetry({
    instrumentations: config?.instrumentations,
    workloadType: "service",
  })

  // Create service logger (reads K_SERVICE and K_REVISION from env)
  logger = createLogger({
    level: config?.level || (process.env.LOG_LEVEL as any) || "info",
    labels: config?.labels,
  })

  // Graceful shutdown
  process.on("SIGTERM", shutdown)

  initialized = true
  return logger
}

/**
 * Initialize OpenTelemetry + Winston logger for Cloud Run Jobs.
 *
 * Reads configuration from environment variables:
 * - CLOUD_RUN_JOB (required) - Job name, automatically set by Cloud Run
 * - CLOUD_RUN_EXECUTION (auto-set) - Execution ID for synthetic traces
 * - CLOUD_RUN_TASK_INDEX (auto-set) - Task index for parallel tasks
 * - GOOGLE_CLOUD_PROJECT (optional) - Project ID for trace correlation, auto-detected if not set
 * - JOB_VERSION (optional) - Job version, automatically set by Cloud Run
 * - LOG_LEVEL (optional) - Log level, default "info"
 * - NODE_ENV=development (optional) - Enables local console output
 *
 * Use this for Cloud Run jobs (batch processing, data pipelines, scheduled tasks).
 * Much lighter than init() - no unnecessary HTTP instrumentation.
 *
 * CRITICAL: Must be called BEFORE any other imports.
 *
 * @example
 * ```typescript
 * // job.ts - Very first line!
 * import { initJob } from '@nirvana-tools/otel-logger'
 * const logger = initJob()
 *
 * // Now import the rest
 * import { processData } from './processor'
 *
 * async function main() {
 *   logger.info('Job started')
 *   await processData()
 *   logger.info('Job completed')
 * }
 *
 * main().catch(err => {
 *   logger.error('Job failed', { error: err })
 *   process.exit(1)
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Optional: customize log level and labels
 * const logger = initJob({
 *   level: 'debug',
 *   labels: { team: 'data', pipeline: 'etl' }
 * })
 * ```
 */
export function initJob(config?: InitConfig): winston.Logger {
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Initialize OpenTelemetry with job mode (Winston only, no HTTP/Express)
  // Reads CLOUD_RUN_JOB and JOB_VERSION from env (validated inside)
  sdk = initializeOpenTelemetry({
    instrumentations: config?.instrumentations,
    workloadType: "job",
  })

  // Create job logger with synthetic traces
  // Reads all CLOUD_RUN_* env vars (validated inside)
  logger = createJobLogger({
    level: config?.level || (process.env.LOG_LEVEL as any) || "info",
    labels: config?.labels,
  })

  // Graceful shutdown
  process.on("SIGTERM", shutdown)

  initialized = true
  return logger
}

/**
 * Graceful shutdown handler.
 */
function shutdown() {
  sdk
    ?.shutdown()
    .then(() => logger?.info("OpenTelemetry SDK shut down"))
    .catch((error) => logger?.error("Error shutting down OpenTelemetry SDK", { error }))
}

/**
 * Get the initialized logger.
 * Throws if init() hasn't been called yet.
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error("Logger not initialized. Call init() first.")
  }
  return logger
}
