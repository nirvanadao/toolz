import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

/**
 * Single initialization for OpenTelemetry + Logger.
 *
 * IMPORTANT: Call this as the FIRST thing in your application.
 * Returns an initialized logger ready to use.
 */
export interface InitConfig {
  /**
   * Override auto-detected service name.
   * @default K_SERVICE || CLOUD_RUN_JOB
   */
  serviceName?: string

  /**
   * Override auto-detected project ID.
   * @default GOOGLE_CLOUD_PROJECT
   */
  projectId?: string

  /**
   * Additional instrumentations beyond defaults.
   */
  instrumentations?: any[]

  /**
   * Minimum log level.
   * @default "info"
   */
  level?: string

  /**
   * Additional labels for Cloud Logging.
   */
  labels?: Record<string, string>
}

let initialized = false
let sdk: NodeSDK | null = null
let logger: winston.Logger | null = null

/**
 * Initialize OpenTelemetry + Winston logger in one call.
 *
 * Auto-discovers all Cloud Run environment variables.
 * Sets up HTTP, Express, and Winston instrumentation automatically.
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
 * // ... app setup ...
 *
 * app.get('/api', (req, res) => {
 *   logger.info('Request received')  // Automatically includes trace!
 *   res.json({ ok: true })
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

  // Auto-discover Cloud Run environment
  const serviceName =
    config?.serviceName ||
    process.env.K_SERVICE ||
    process.env.CLOUD_RUN_JOB ||
    "unknown"

  const serviceVersion =
    process.env.K_REVISION || process.env.JOB_VERSION || "unknown"

  const projectId =
    config?.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID

  const level = config?.level || process.env.LOG_LEVEL || "info"
  const isLocal = process.env.NODE_ENV === "development"

  // Initialize OpenTelemetry
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")
  const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express")
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new WinstonInstrumentation(),
      ...(config?.instrumentations || []),
    ],
  })

  sdk.start()

  // Create logger
  const transports: winston.transport[] = []

  if (isLocal) {
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
    if (!projectId) {
      throw new Error(
        "projectId required for Cloud Logging. Set GOOGLE_CLOUD_PROJECT or pass config.projectId",
      )
    }

    transports.push(
      new LoggingWinston({
        projectId,
        serviceContext: {
          service: serviceName,
          version: serviceVersion,
        },
        labels: config?.labels,
        redirectToStdout: true,
      }),
    )
  }

  logger = winston.createLogger({
    level,
    defaultMeta: {
      service: serviceName,
      version: serviceVersion,
    },
    transports,
  })

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk
      ?.shutdown()
      .then(() => logger?.info("OpenTelemetry SDK shut down"))
      .catch((error) => logger?.error("Error shutting down OpenTelemetry SDK", { error }))
  })

  initialized = true
  return logger
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
