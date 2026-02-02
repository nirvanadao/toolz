/**
 * Google Cloud Logging severity levels.
 * @see https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
export type Severity =
  | "DEBUG"
  | "INFO"
  | "NOTICE"
  | "WARNING"
  | "ERROR"
  | "CRITICAL"
  | "ALERT"
  | "EMERGENCY"

/**
 * Structured log entry format for Google Cloud Logging.
 * Fields follow the special JSON payload format that Cloud Logging recognizes.
 * @see https://cloud.google.com/logging/docs/structured-logging
 */
export type LogEntry = {
  /** Log severity level */
  severity: Severity
  /** Human-readable log message */
  message: string
  /** ISO 8601 timestamp */
  timestamp: string
  /**
   * Trace identifier for correlating logs with Cloud Trace.
   * Format: "projects/PROJECT_ID/traces/TRACE_ID"
   */
  "logging.googleapis.com/trace"?: string
  /**
   * Span identifier within a trace.
   */
  "logging.googleapis.com/spanId"?: string
  /**
   * Whether this log is sampled for tracing.
   */
  "logging.googleapis.com/trace_sampled"?: boolean
  /**
   * Indexed labels for fast filtering in Cloud Logging.
   * Use for high-cardinality filtering like component names, environments, etc.
   * @see https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#FIELDS.labels
   */
  "logging.googleapis.com/labels"?: Record<string, string>
  /** Additional structured data */
  [key: string]: unknown
}

/**
 * Trace context parsed from X-Cloud-Trace-Context header.
 */
export type TraceContext = {
  /** Full trace resource name: "projects/PROJECT_ID/traces/TRACE_ID" */
  trace: string
  /** Span ID within the trace */
  spanId?: string
  /** Whether the trace is being sampled */
  sampled?: boolean
}

/**
 * Service context for Google Cloud Error Reporting.
 * Used to group errors by service and version.
 * @see https://cloud.google.com/error-reporting/docs/formatting-error-messages#@type/type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ServiceContext
 */
export type ServiceContext = {
  /**
   * Service name. Should match your Cloud Run service name.
   * @example "api-gateway"
   */
  service: string
  /**
   * Service version. Useful for tracking which version produced errors.
   * @example "1.2.3"
   */
  version?: string
}

/**
 * Configuration options for the CloudRunLogger.
 */
export type LoggerConfig = {
  /**
   * Google Cloud project ID. Required for trace correlation.
   * If not provided, trace context will not include the full resource path.
   * @example "my-gcp-project"
   */
  projectId?: string

  /**
   * Minimum severity level to output. Logs below this level are discarded.
   * Useful for reducing noise in production vs development.
   * @default "DEBUG"
   */
  minSeverity?: Severity

  /**
   * Default fields to include in every log entry.
   * Useful for adding service name, version, environment, etc.
   * @example { service: "api-gateway", version: "1.2.3" }
   */
  defaultFields?: Record<string, unknown>

  /**
   * Labels for indexed filtering in Cloud Logging.
   * These appear as `logging.googleapis.com/labels` and are indexed for fast queries.
   * Use for filtering by component, environment, tenant, etc.
   *
   * Filter in Cloud Logging with: `labels.component="pubsub-publisher"`
   *
   * @example { component: "pubsub-publisher", env: "prod" }
   */
  labels?: Record<string, string>

  /**
   * Service context for Google Cloud Error Reporting.
   * REQUIRED for Error Reporting to group errors by service.
   * Include the service name and optionally the version.
   *
   * @example { service: "api-gateway", version: "1.2.3" }
   */
  serviceContext?: ServiceContext
}

const SEVERITY_ORDER: Record<Severity, number> = {
  DEBUG: 0,
  INFO: 1,
  NOTICE: 2,
  WARNING: 3,
  ERROR: 4,
  CRITICAL: 5,
  ALERT: 6,
  EMERGENCY: 7,
}

/**
 * A structured JSON logger optimized for Google Cloud Run and Cloud Logging.
 *
 * Features:
 * - Outputs single-line JSON to stdout/stderr (Cloud Logging requirement)
 * - Supports all GCP severity levels
 * - Trace context correlation via X-Cloud-Trace-Context header
 * - Automatic timestamp generation
 * - Safe serialization of errors and circular references
 *
 * @example
 * ```ts
 * const logger = new CloudRunLogger({ projectId: "my-project" })
 *
 * logger.info("User logged in", { userId: "123" })
 * // {"severity":"INFO","message":"User logged in","timestamp":"...","userId":"123"}
 *
 * // With trace context (from middleware)
 * logger.withTrace(traceContext).info("Processing request")
 * ```
 */
export class CloudRunLogger {
  private config: LoggerConfig
  private traceContext?: TraceContext

  constructor(config: LoggerConfig = {}) {
    this.config = {
      minSeverity: "DEBUG",
      ...config,
    }
  }

  /**
   * Creates a child logger with trace context attached.
   * All logs from this logger will include trace correlation fields.
   */
  public withTrace(traceContext: TraceContext): CloudRunLogger {
    const child = new CloudRunLogger(this.config)
    child.traceContext = traceContext
    return child
  }

  /**
   * Creates a child logger with additional default fields.
   * Useful for adding request-specific context.
   */
  public withFields(fields: Record<string, unknown>): CloudRunLogger {
    const child = new CloudRunLogger({
      ...this.config,
      defaultFields: {
        ...this.config.defaultFields,
        ...fields,
      },
    })
    child.traceContext = this.traceContext
    return child
  }

  /**
   * Creates a child logger with additional indexed labels.
   * Labels are indexed by Cloud Logging for fast filtering.
   *
   * @example
   * ```ts
   * // Create a component-specific logger
   * const pubsubLogger = logger.withLabels({ component: "pubsub-publisher" })
   * pubsubLogger.info("Publishing message")
   *
   * // Filter in Cloud Logging: labels.component="pubsub-publisher"
   * ```
   */
  public withLabels(labels: Record<string, string>): CloudRunLogger {
    const child = new CloudRunLogger({
      ...this.config,
      labels: {
        ...this.config.labels,
        ...labels,
      },
    })
    child.traceContext = this.traceContext
    return child
  }

  /** Log at DEBUG severity. Use for verbose debugging information. */
  public debug(message: string, data?: Record<string, unknown>): void {
    this.log("DEBUG", message, data)
  }

  /** Log at INFO severity. Use for routine operational messages. */
  public info(message: string, data?: Record<string, unknown>): void {
    this.log("INFO", message, data)
  }

  /** Log at NOTICE severity. Use for significant but normal events. */
  public notice(message: string, data?: Record<string, unknown>): void {
    this.log("NOTICE", message, data)
  }

  /** Log at WARNING severity. Use for potentially harmful situations. */
  public warn(message: string, data?: Record<string, unknown>): void {
    this.log("WARNING", message, data)
  }

  /** Log at ERROR severity. Use for error events that might still allow the app to continue. */
  public error(message: string, data?: Record<string, unknown>): void {
    this.log("ERROR", message, data)
  }

  /** Log at CRITICAL severity. Use for critical conditions requiring immediate attention. */
  public critical(message: string, data?: Record<string, unknown>): void {
    this.log("CRITICAL", message, data)
  }

  /** Log at ALERT severity. Use when action must be taken immediately. */
  public alert(message: string, data?: Record<string, unknown>): void {
    this.log("ALERT", message, data)
  }

  /** Log at EMERGENCY severity. Use when the system is unusable. */
  public emergency(message: string, data?: Record<string, unknown>): void {
    this.log("EMERGENCY", message, data)
  }

  /**
   * Log an error object with stack trace.
   * Extracts error properties and formats them for Cloud Error Reporting.
   *
   * The stack trace is placed at the top level of the log entry so that
   * Google Cloud Error Reporting can automatically detect and group errors.
   *
   * @example
   * ```ts
   * try {
   *   await riskyOperation()
   * } catch (err) {
   *   logger.logError("ERROR", "Operation failed", err as Error, { operationId: "123" })
   * }
   * ```
   */
  public logError(
    severity: Severity,
    message: string,
    error: Error,
    data?: Record<string, unknown>,
  ): void {
    this.log(severity, message, {
      ...data,
      // Pass error object so log() can promote stack to top level
      error,
    })
  }

  private log(
    severity: Severity,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(severity)) {
      return
    }

    // Extract error object if present for special handling
    // This ensures Error Reporting can parse the error properly
    let errorObj: Error | undefined
    let restData = data

    if (data?.error instanceof Error) {
      errorObj = data.error
      const { error, ...rest } = data
      restData = rest
    }

    const entry: LogEntry = {
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...this.config.defaultFields,
      ...restData,
    }

    // Add error fields at top level for Error Reporting auto-detection
    // Error Reporting looks for a top-level "stack" field
    if (errorObj) {
      entry.stack = errorObj.stack
      // Keep structured error info for additional context
      entry.error = {
        name: errorObj.name,
        message: errorObj.message,
      }
    }

    // Add service context for Error Reporting (helps group errors by service)
    if (this.config.serviceContext) {
      entry.serviceContext = this.config.serviceContext
    }

    // Add trace context if available
    if (this.traceContext) {
      entry["logging.googleapis.com/trace"] = this.traceContext.trace
      if (this.traceContext.spanId) {
        entry["logging.googleapis.com/spanId"] = this.traceContext.spanId
      }
      if (this.traceContext.sampled !== undefined) {
        entry["logging.googleapis.com/trace_sampled"] = this.traceContext.sampled
      }
    }

    // Add indexed labels if configured
    if (this.config.labels && Object.keys(this.config.labels).length > 0) {
      entry["logging.googleapis.com/labels"] = this.config.labels
    }

    // Output to appropriate stream (stderr for ERROR and above)
    const output = this.serialize(entry)
    if (SEVERITY_ORDER[severity] >= SEVERITY_ORDER.ERROR) {
      process.stderr.write(output + "\n")
    } else {
      process.stdout.write(output + "\n")
    }
  }

  private shouldLog(severity: Severity): boolean {
    const minLevel = SEVERITY_ORDER[this.config.minSeverity ?? "DEBUG"]
    const currentLevel = SEVERITY_ORDER[severity]
    return currentLevel >= minLevel
  }

  /**
   * Safely serialize the log entry to JSON.
   * Handles circular references and BigInt values.
   */
  private serialize(entry: LogEntry): string {
    try {
      return JSON.stringify(entry, this.replacer)
    } catch {
      // Fallback for truly unserializable data
      return JSON.stringify({
        severity: entry.severity,
        message: entry.message,
        timestamp: entry.timestamp,
        serializationError: "Failed to serialize log entry",
      })
    }
  }

  private replacer = (_key: string, value: unknown): unknown => {
    // Handle BigInt
    if (typeof value === "bigint") {
      return value.toString()
    }
    // Handle Error objects
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      }
    }
    return value
  }
}

/**
 * Install global error handlers that log uncaught exceptions and unhandled promise rejections.
 *
 * This ensures that process-level failures are logged to Cloud Logging with proper
 * Error Reporting format before the process exits. Uncaught exceptions will still
 * crash the process (as they should), but you'll have structured logs in GCP.
 *
 * Call this once during application startup:
 * ```ts
 * const logger = new CloudRunLogger({
 *   projectId: "my-project",
 *   serviceContext: { service: "my-service", version: "1.0.0" }
 * })
 * installGlobalErrorHandlers(logger)
 * ```
 *
 * @param logger The logger instance to use for logging errors
 * @param exitOnUncaughtException Whether to exit the process after logging (default: true)
 */
export function installGlobalErrorHandlers(
  logger: CloudRunLogger,
  exitOnUncaughtException = true,
): void {
  // Handle uncaught exceptions
  process.on("uncaughtException", (error: Error) => {
    logger.critical("Uncaught exception", { error })

    if (exitOnUncaughtException) {
      // Give the logger a moment to flush before exiting
      // In Cloud Run, logs are buffered and may not appear without this
      setTimeout(() => {
        process.exit(1)
      }, 1000)
    }
  })

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason: unknown, promise: Promise<unknown>) => {
    // Convert non-Error rejections to Error objects
    const error =
      reason instanceof Error
        ? reason
        : new Error(`Unhandled rejection: ${String(reason)}`)

    logger.critical("Unhandled promise rejection", {
      error,
      promise: String(promise),
    })
  })

  // Optional: Handle warnings (useful for debugging dependency issues)
  process.on("warning", (warning: Error) => {
    logger.warn("Process warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    })
  })
}

/**
 * Parse the X-Cloud-Trace-Context header into a TraceContext object.
 *
 * Header format: "TRACE_ID/SPAN_ID;o=TRACE_TRUE"
 * - TRACE_ID: 32-character hex string
 * - SPAN_ID: decimal number (optional)
 * - TRACE_TRUE: 1 if sampled, 0 if not (optional)
 *
 * @param header The X-Cloud-Trace-Context header value
 * @param projectId The GCP project ID for constructing the full trace resource name
 * @returns TraceContext object or undefined if header is invalid/missing
 *
 * @example
 * ```ts
 * const ctx = parseTraceHeader(
 *   "105445aa7843bc8bf206b120001000/1;o=1",
 *   "my-project"
 * )
 * // { trace: "projects/my-project/traces/105445aa7843bc8bf206b120001000", spanId: "1", sampled: true }
 * ```
 */
export function parseTraceHeader(
  header: string | undefined,
  projectId?: string,
): TraceContext | undefined {
  if (!header) {
    return undefined
  }

  // Format: "TRACE_ID/SPAN_ID;o=TRACE_TRUE" or "TRACE_ID/SPAN_ID" or "TRACE_ID"
  const match = header.match(/^([a-f0-9]+)(?:\/(\d+))?(?:;o=([01]))?$/i)
  if (!match) {
    return undefined
  }

  const [, traceId, spanId, sampledFlag] = match

  // Build the trace resource name
  const trace = projectId
    ? `projects/${projectId}/traces/${traceId}`
    : traceId

  return {
    trace,
    spanId: spanId || undefined,
    sampled: sampledFlag ? sampledFlag === "1" : undefined,
  }
}
