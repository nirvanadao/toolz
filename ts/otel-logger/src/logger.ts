import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

/**
 * Configuration options for createLogger.
 *
 * Service name and version are read from Cloud Run environment variables (guaranteed to be set).
 * Project ID is auto-detected from GCP metadata server.
 */
export interface LoggerConfig {
  /**
   * Log level.
   * @default "info"
   */
  level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"

  /**
   * Additional default metadata included in all logs.
   */
  defaultMeta?: Record<string, unknown>

  /**
   * Cloud Logging labels for indexed filtering.
   * @example { component: "api", environment: "prod" }
   */
  labels?: Record<string, string>
}

/**
 * Creates a production-ready Winston logger with Google Cloud Logging integration
 * and automatic OpenTelemetry trace correlation.
 *
 * Features:
 * - Automatic trace/span injection via @opentelemetry/instrumentation-winston
 * - Cloud Logging compatible format
 * - Error Reporting integration via serviceContext
 * - Local development mode with console output
 *
 * IMPORTANT: You must initialize OpenTelemetry SDK before creating the logger
 * for automatic trace correlation to work. Use `initializeOpenTelemetry()` first.
 *
 * @example
 * ```ts
 * // Setup once at application startup
 * import { initializeOpenTelemetry, createLogger } from '@nirvana-tools/otel-logger'
 *
 * // Initialize OpenTelemetry FIRST (must be done before any imports)
 * initializeOpenTelemetry({
 *   serviceName: 'my-service',
 *   serviceVersion: '1.0.0'
 * })
 *
 * // Create logger
 * export const logger = createLogger({
 *   projectId: process.env.GOOGLE_CLOUD_PROJECT
 * })
 *
 * // Use anywhere - traces automatically correlated within HTTP requests
 * logger.info('User logged in', { userId: '123' })
 * ```
 */
export function createLogger(config?: LoggerConfig): winston.Logger {
  // Read guaranteed Cloud Run environment variables
  const serviceName = process.env.K_SERVICE || process.env.CLOUD_RUN_JOB
  const serviceVersion = process.env.K_REVISION || process.env.JOB_VERSION

  if (!serviceName) {
    throw new Error(
      "K_SERVICE or CLOUD_RUN_JOB environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!serviceVersion) {
    throw new Error(
      "K_REVISION or JOB_VERSION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  const level = config?.level || (process.env.LOG_LEVEL as any) || "info"
  const isLocalDev = process.env.NODE_ENV === "development"

  const transports: winston.transport[] = []

  if (isLocalDev) {
    // Local development: use console transport with colors
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
    // Production: use Cloud Logging transport
    // LoggingWinston auto-detects projectId from GCP metadata server
    const loggingWinston = new LoggingWinston({
      // Service context for Error Reporting
      serviceContext: {
        service: serviceName,
        version: serviceVersion,
      },
      // Labels for indexed filtering
      labels: config?.labels,
      // Redirect to stdout for Cloud Run (logs go to Cloud Logging automatically)
      redirectToStdout: true,
    })

    transports.push(loggingWinston)
  }

  return winston.createLogger({
    level,
    defaultMeta: {
      service: serviceName,
      version: serviceVersion,
      ...config?.defaultMeta,
    },
    transports,
  })
}
