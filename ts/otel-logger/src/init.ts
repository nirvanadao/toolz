import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"
import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

/**
 * Configuration for init().
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
 * Initialize OpenTelemetry + Winston logger for Cloud Run.
 *
 * Auto-detects whether running as a service or job:
 * - Service (K_SERVICE set): HTTP + Express + Winston instrumentation
 * - Job (CLOUD_RUN_JOB set): Winston only (no HTTP overhead)
 *
 * CRITICAL: Must be called BEFORE any other imports.
 *
 * @example
 * ```typescript
 * // Service
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()
 *
 * import express from 'express'
 * const app = express()
 * app.get('/api', (req, res) => {
 *   logger.info('Request')
 *   res.json({ ok: true })
 * })
 * ```
 *
 * @example
 * ```typescript
 * // Job
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()
 *
 * async function main() {
 *   logger.info('Job started')
 *   await processData()
 * }
 * ```
 */
export function init(config?: InitConfig): winston.Logger {
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Auto-detect workload type from Cloud Run env vars
  const isService = !!process.env.K_SERVICE
  const isJob = !!process.env.CLOUD_RUN_JOB

  if (!isService && !isJob) {
    throw new Error(
      "Could not detect Cloud Run workload type. Set K_SERVICE (for services) or CLOUD_RUN_JOB (for jobs).",
    )
  }

  if (isService && isJob) {
    throw new Error(
      "Both K_SERVICE and CLOUD_RUN_JOB are set. This should not happen in Cloud Run.",
    )
  }

  if (isService) {
    initService(config)
  } else {
    initJob(config)
  }

  initialized = true
  return logger!
}

/**
 * Initialize for Cloud Run service.
 */
function initService(config?: InitConfig) {
  const serviceName = process.env.K_SERVICE!
  const serviceVersion = process.env.K_REVISION

  if (!serviceVersion) {
    throw new Error(
      "K_REVISION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  // Initialize OpenTelemetry for services (HTTP + Express + Winston)
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")
  const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express")
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new TraceExporter(),
    instrumentations: [
      new WinstonInstrumentation(),
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      ...(config?.instrumentations || []),
    ],
  })

  sdk.start()

  // Create logger
  logger = createWinstonLogger({
    serviceName,
    serviceVersion,
    level: config?.level,
    labels: config?.labels,
  })

  // Graceful shutdown
  process.on("SIGTERM", shutdown)
}

/**
 * Initialize for Cloud Run job.
 */
function initJob(config?: InitConfig) {
  const jobName = process.env.CLOUD_RUN_JOB!
  const jobVersion = process.env.JOB_VERSION
  const executionId = process.env.CLOUD_RUN_EXECUTION
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT
  const taskAttempt = process.env.CLOUD_RUN_TASK_ATTEMPT

  if (!jobVersion) {
    throw new Error(
      "JOB_VERSION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!executionId) {
    throw new Error(
      "CLOUD_RUN_EXECUTION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!taskIndex) {
    throw new Error(
      "CLOUD_RUN_TASK_INDEX environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!taskCount) {
    throw new Error(
      "CLOUD_RUN_TASK_COUNT environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!taskAttempt) {
    throw new Error(
      "CLOUD_RUN_TASK_ATTEMPT environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  // Initialize OpenTelemetry for jobs (Winston only, no HTTP)
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: jobName,
      [ATTR_SERVICE_VERSION]: jobVersion,
    }),
    traceExporter: new TraceExporter(),
    instrumentations: [
      new WinstonInstrumentation(),
      ...(config?.instrumentations || []),
    ],
  })

  sdk.start()

  // Create logger with job-specific labels and metadata
  logger = createWinstonLogger({
    serviceName: jobName,
    serviceVersion: jobVersion,
    level: config?.level,
    labels: {
      job: jobName,
      execution: executionId,
      task: taskIndex,
      ...config?.labels,
    },
    defaultMeta: {
      taskAttempt: parseInt(taskAttempt, 10),
      taskCount: parseInt(taskCount, 10),
    },
  })

  // Graceful shutdown
  process.on("SIGTERM", shutdown)
}

/**
 * Create Winston logger with Cloud Logging.
 */
function createWinstonLogger(opts: {
  serviceName: string
  serviceVersion: string
  level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"
  labels?: Record<string, string>
  defaultMeta?: Record<string, unknown>
}): winston.Logger {
  const level = opts.level || (process.env.LOG_LEVEL as any) || "info"
  const isLocalDev = process.env.NODE_ENV === "development"

  const transports: winston.transport[] = []

  if (isLocalDev) {
    // Local dev: console output
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const metaStr = Object.keys(meta).length
              ? "\n" + JSON.stringify(meta, null, 2)
              : ""
            return `${timestamp} ${level}: ${message}${metaStr}`
          }),
        ),
      }),
    )
  } else {
    // Production: Cloud Logging (auto-detects projectId from metadata server)
    transports.push(
      new LoggingWinston({
        serviceContext: {
          service: opts.serviceName,
          version: opts.serviceVersion,
        },
        labels: opts.labels,
        redirectToStdout: true,
      }),
    )
  }

  return winston.createLogger({
    level,
    defaultMeta: {
      service: opts.serviceName,
      version: opts.serviceVersion,
      ...opts.defaultMeta,
    },
    transports,
  })
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
