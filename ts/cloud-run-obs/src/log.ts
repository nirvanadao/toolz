import winston from "winston"
import { trace, context } from "@opentelemetry/api"

/**
 * ============================================================================
 * CONFIGURATION & TYPES
 * ============================================================================
 */

const levels = {
  emergency: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

const severityMap: Record<string, string> = {
  emergency: "EMERGENCY",
  error: "ERROR",
  warn: "WARNING",
  info: "INFO",
  debug: "DEBUG",
}

// Define the shape of our Strict Logger so we can recursively return it
export interface Logger {
  debug: (message: string, meta?: Record<string, any>) => void
  info: (message: string, meta?: Record<string, any>) => void
  warn: (message: string, meta?: Record<string, any>) => void
  error: (err: Error, meta?: Record<string, any>) => void
  emergency: (err: Error, meta?: Record<string, any>) => void
  child: (bindings: Record<string, any>) => Logger
  _root: winston.Logger
}

export type LoggerArgs = {
  serviceName: string
  serviceVersion: string
  level: "debug" | "info" | "warn" | "error" | "emergency"
  // Optional: GCP Labels (indexed at top level)
  labels?: Record<string, string>
  // Optional: JSON Payload metadata (merged into jsonPayload)
  defaultMeta?: Record<string, unknown>
}

/**
 * ============================================================================
 * INTERNAL WRAPPER
 * Wraps a raw Winston instance to enforce our Strict Logger interface.
 * ============================================================================
 */
const wrapLogger = (winstonInstance: winston.Logger): Logger => {
  return {
    debug: (message: string, meta?: Record<string, any>) => {
      winstonInstance.debug(message, meta)
    },

    info: (message: string, meta?: Record<string, any>) => {
      winstonInstance.info(message, meta)
    },

    warn: (message: string, meta?: Record<string, any>) => {
      winstonInstance.warn(message, meta)
    },

    error: (err: Error, meta?: Record<string, any>) => {
      winstonInstance.error(err.message, { ...meta, error: err })
    },

    emergency: (err: Error, meta?: Record<string, any>) => {
      winstonInstance.log("emergency", err.message, { ...meta, error: err })
    },

    /**
     * Creates a child logger.
     * Delegates to Winston's .child() which handles defaultMeta merging.
     */
    child: (bindings: Record<string, any>) => {
      return wrapLogger(winstonInstance.child(bindings))
    },

    _root: winstonInstance,
  }
}

/**
 * ============================================================================
 * FACTORY
 * ============================================================================
 */
export const createLogger = (args: LoggerArgs): Logger => {
  const { serviceName, serviceVersion, level, labels, defaultMeta } = args

  const serviceContext = {
    service: serviceName,
    version: serviceVersion,
  }

  // 1. Google Format (Closure over serviceContext)
  const googleFormat = winston.format((info) => {
    // A. Map Level to Severity
    info["severity"] = severityMap[info.level] || "INFO"

    // B. Attach Service Context to Errors/Emergencies
    if (info["severity"] === "ERROR" || info["severity"] === "EMERGENCY") {
      info["serviceContext"] = serviceContext
    }

    // C. Inject Trace & Span IDs
    const span = trace.getSpan(context.active())
    if (span) {
      const { traceId, spanId } = span.spanContext()
      const projectId = process.env.GOOGLE_CLOUD_PROJECT
      if (projectId) {
        info["logging.googleapis.com/trace"] = `projects/${projectId}/traces/${traceId}`
        info["logging.googleapis.com/spanId"] = spanId
      }
    }

    // D. Lift Stack Trace
    if (info.error && info.error instanceof Error) {
      info.stack = info.error.stack
      if (info.message !== info.error.message) {
        info.message = `${info.message}: ${info.error.message}`
      } else {
        info.message = info.error.message
      }
    }

    return info
  })

  // 2. Label Injector (Handle "labels" vs "defaultMeta")
  // Injects into logging.googleapis.com/labels for top-level indexing
  const injectLabels = winston.format((info) => {
    if (labels) {
      info["logging.googleapis.com/labels"] = labels
    }
    return info
  })

  // 3. Create Winston Instance
  const winstonInstance = winston.createLogger({
    levels,
    level,
    // defaultMeta is automatically merged into the JSON payload of every log
    defaultMeta: defaultMeta || {},
    format: winston.format.combine(
      injectLabels(), // Add GCP Labels first
      googleFormat(), // Apply Google logic
      winston.format.json(), // Finalize as JSON
    ),
    transports: [new winston.transports.Console()],
  })

  return wrapLogger(winstonInstance)
}
