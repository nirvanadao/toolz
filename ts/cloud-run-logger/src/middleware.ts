import type { Request, Response, NextFunction } from "express"
import { CloudRunLogger, parseTraceHeader, TraceContext } from "./logger"

/**
 * Key used to store the logger instance on the request object.
 */
export const REQUEST_LOGGER_KEY = "log" as const

/**
 * Augment the Express Request type to include our logger.
 * Users can also augment this in their own code for full type safety.
 */
declare global {
  namespace Express {
    interface Request {
      /** Request-scoped logger with trace context */
      log: CloudRunLogger
      /** Parsed trace context from X-Cloud-Trace-Context header */
      traceContext?: TraceContext
    }
  }
}

/**
 * Configuration options for the logging middleware.
 */
export type LoggingMiddlewareConfig = {
  /**
   * Google Cloud project ID. Required for proper trace correlation.
   * @example "my-gcp-project"
   */
  projectId?: string

  /**
   * Base logger instance to use. If not provided, creates a new one.
   * Useful for sharing configuration across the application.
   */
  logger?: CloudRunLogger

  /**
   * Whether to log incoming requests automatically.
   * @default true
   */
  logRequests?: boolean

  /**
   * Whether to log response completion automatically.
   * @default true
   */
  logResponses?: boolean

  /**
   * Fields to exclude from automatic request logging (e.g., sensitive headers).
   * @default ["authorization", "cookie", "x-api-key"]
   */
  excludeHeaders?: string[]

  /**
   * Paths to skip logging entirely (e.g., health checks).
   * Supports exact matches and simple glob patterns with *.
   * @default ["/healthz", "/readyz", "/health", "/ready"]
   */
  skipPaths?: string[]
}

const DEFAULT_EXCLUDED_HEADERS = ["authorization", "cookie", "x-api-key"]
const DEFAULT_SKIP_PATHS = ["/healthz", "/readyz", "/health", "/ready"]

/**
 * Express middleware that attaches a request-scoped logger with trace context.
 *
 * Features:
 * - Parses X-Cloud-Trace-Context header for trace correlation
 * - Attaches a logger to `req.log` with trace context pre-configured
 * - Optionally logs request/response automatically
 * - Skips noisy health check endpoints
 *
 * @example
 * ```ts
 * import express from "express"
 * import { loggingMiddleware, CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
 *
 * const app = express()
 * const logger = new CloudRunLogger({ projectId: "my-project" })
 *
 * app.use(loggingMiddleware({ logger, projectId: "my-project" }))
 *
 * app.get("/api/users", (req, res) => {
 *   req.log.info("Fetching users", { query: req.query })
 *   // ...
 * })
 * ```
 */
export function loggingMiddleware(
  config: LoggingMiddlewareConfig = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const {
    projectId,
    logger = new CloudRunLogger({ projectId }),
    logRequests = true,
    logResponses = true,
    excludeHeaders = DEFAULT_EXCLUDED_HEADERS,
    skipPaths = DEFAULT_SKIP_PATHS,
  } = config

  const excludeHeadersLower = excludeHeaders.map((h) => h.toLowerCase())

  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now()

    // Parse trace context from header
    const traceHeader = req.get("x-cloud-trace-context")
    const traceContext = parseTraceHeader(traceHeader, projectId)

    // Attach trace context and logger to request
    req.traceContext = traceContext

    // Create request-scoped logger with trace context and request metadata
    const requestLogger = traceContext
      ? logger.withTrace(traceContext).withFields({
          httpRequest: {
            requestMethod: req.method,
            requestUrl: req.originalUrl,
          },
        })
      : logger.withFields({
          httpRequest: {
            requestMethod: req.method,
            requestUrl: req.originalUrl,
          },
        })

    req.log = requestLogger

    // Check if we should skip logging for this path
    const shouldSkip = skipPaths.some((pattern) => matchPath(pattern, req.path))

    // Log incoming request
    if (logRequests && !shouldSkip) {
      const safeHeaders = filterHeaders(req.headers, excludeHeadersLower)
      requestLogger.info("Request received", {
        headers: safeHeaders,
        query: req.query,
        ip: req.ip || req.socket?.remoteAddress,
      })
    }

    // Log response on finish
    if (logResponses && !shouldSkip) {
      res.on("finish", () => {
        const duration = Date.now() - startTime
        const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"

        requestLogger[level]("Request completed", {
          httpRequest: {
            requestMethod: req.method,
            requestUrl: req.originalUrl,
            status: res.statusCode,
            latency: `${duration}ms`,
          },
          responseSize: res.get("content-length"),
        })
      })
    }

    next()
  }
}

/**
 * Simple path matching supporting exact matches and * wildcards.
 */
function matchPath(pattern: string, path: string): boolean {
  if (pattern === path) {
    return true
  }
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*") + "$",
    )
    return regex.test(path)
  }
  return false
}

/**
 * Filter out sensitive headers from logging.
 */
function filterHeaders(
  headers: Request["headers"],
  excludeList: string[],
): Record<string, string | string[] | undefined> {
  const filtered: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!excludeList.includes(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

/**
 * Creates a simple request ID middleware that generates or forwards request IDs.
 * Works well in combination with loggingMiddleware.
 *
 * @param headerName The header to check for existing request ID
 * @default "x-request-id"
 */
export function requestIdMiddleware(
  headerName = "x-request-id",
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = req.get(headerName) || generateRequestId()

    // Set on response header for client correlation
    res.set(headerName, requestId)

    // If logger is already attached, add requestId to it
    if (req.log) {
      req.log = req.log.withFields({ requestId })
    }

    next()
  }
}

/**
 * Generate a simple random request ID.
 */
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`
}
