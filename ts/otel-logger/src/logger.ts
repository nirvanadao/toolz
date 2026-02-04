import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

/**
 * Configuration options for createLogger.
 */
export interface LoggerConfig {
  /**
   * Google Cloud project ID. Required for Cloud Logging.
   * @default process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT_ID
   */
  projectId?: string

  /**
   * Service name for Cloud Error Reporting.
   * @default process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || "unknown"
   */
  serviceName?: string

  /**
   * Service version for Error Reporting.
   * @default process.env.K_REVISION || process.env.JOB_VERSION || "unknown"
   */
  serviceVersion?: string

  /**
   * Minimum log level.
   * @default "info"
   */
  level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"

  /**
   * Enable local development mode with console transport.
   * @default process.env.NODE_ENV === "development"
   */
  local?: boolean

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
  const projectId =
    config?.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID

  const serviceName =
    config?.serviceName ||
    process.env.K_SERVICE ||
    process.env.CLOUD_RUN_JOB ||
    "unknown"

  const serviceVersion =
    config?.serviceVersion ||
    process.env.K_REVISION ||
    process.env.JOB_VERSION ||
    "unknown"

  const level = config?.level || (process.env.LOG_LEVEL as any) || "info"
  const local = config?.local ?? process.env.NODE_ENV === "development"

  const transports: winston.transport[] = []

  if (local) {
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
    if (!projectId) {
      throw new Error(
        "projectId is required for Cloud Logging. Provide via config or GOOGLE_CLOUD_PROJECT env var",
      )
    }

    const loggingWinston = new LoggingWinston({
      projectId,
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
