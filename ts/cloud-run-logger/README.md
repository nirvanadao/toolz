# @nirvana-tools/cloud-run-logger

Production-grade structured JSON logging for Google Cloud Run with trace correlation, Error Reporting integration, and Express middleware.

## Features

- **Structured JSON output** - Single-line JSON logs that Cloud Logging parses automatically
- **All GCP severity levels** - DEBUG, INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT, EMERGENCY
- **Error Reporting integration** - Automatic error detection by Google Cloud Error Reporting
- **Global error handlers** - Capture uncaught exceptions and unhandled rejections
- **Trace correlation** - Automatic `X-Cloud-Trace-Context` header parsing for request tracing
- **Indexed labels** - Filter logs by component, environment, tenant, etc. using `logging.googleapis.com/labels`
- **Express middleware** - Auto-inject trace context and request-scoped loggers
- **Safe serialization** - Handles BigInt, Error objects, and circular references

## Installation

```bash
pnpm add @nirvana-tools/cloud-run-logger
```

## Quick Start

```ts
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

const logger = new CloudRunLogger({ projectId: "my-gcp-project" })

logger.info("Application started", { port: 8080 })
// {"severity":"INFO","message":"Application started","timestamp":"2024-01-15T10:30:00.000Z","port":8080}

logger.error("Failed to connect", { host: "db.example.com" })
// Writes to stderr for ERROR and above
```

## Configuration

```ts
const logger = new CloudRunLogger({
  // Required for trace correlation
  projectId: "my-gcp-project",

  // REQUIRED for Error Reporting - groups errors by service
  serviceContext: {
    service: "my-service",
    version: "1.2.3",
  },

  // Minimum severity to output (default: "DEBUG")
  minSeverity: "INFO",

  // Fields included in every log entry
  defaultFields: {
    environment: "prod",
  },

  // Indexed labels for fast Cloud Logging filters
  labels: {
    component: "auth",
    env: "prod",
  },
})
```

## Severity Levels

```ts
logger.debug("Verbose debugging info")
logger.info("Routine operational message")
logger.notice("Significant but normal event")
logger.warn("Potentially harmful situation")
logger.error("Error that allows app to continue")
logger.critical("Critical condition requiring attention")
logger.alert("Action must be taken immediately")
logger.emergency("System is unusable")
```

## Error Reporting Integration

This logger automatically integrates with **Google Cloud Error Reporting** to help you track and triage errors in production.

### How It Works

Errors are automatically detected by Error Reporting when:
1. Log severity is ERROR or higher
2. Log entry has a top-level `stack` field (stack trace string)
3. Log entry has a `serviceContext` field with service name

This logger handles all of this automatically when you log errors.

### Logging Errors

Use `logError()` for handled errors that should appear in Error Reporting:

```ts
try {
  await riskyOperation()
} catch (err) {
  logger.logError("ERROR", "Operation failed", err as Error, {
    operationId: "abc123",
  })
  // Service continues running
  // Error appears in Error Reporting
}
```

Or use the regular log methods with an error in the data:

```ts
try {
  await fetchData()
} catch (err) {
  logger.error("Data fetch failed", { error: err as Error })
  // Also appears in Error Reporting
}
```

### Global Error Handlers

Install global handlers to catch uncaught exceptions and unhandled rejections:

```ts
import { CloudRunLogger, installGlobalErrorHandlers } from "@nirvana-tools/cloud-run-logger"

const logger = new CloudRunLogger({
  projectId: "my-project",
  serviceContext: { service: "my-service", version: "1.0.0" },
})

// Install once at startup
installGlobalErrorHandlers(logger)

// Now uncaught errors are logged before the process exits
throw new Error("This will be logged to Error Reporting")
```

### When to Log vs Throw

**Log errors (don't throw)** for recoverable, request-scoped failures:
- Database query failed → retry or return 500
- Third-party API timeout → use fallback
- Validation errors → return 400

```ts
app.post("/api/orders", async (req, res) => {
  try {
    const order = await createOrder(req.body)
    res.json(order)
  } catch (err) {
    req.log.error("Order creation failed", { error: err as Error })
    res.status(500).json({ error: "Failed to create order" })
    // ✓ Error logged to Error Reporting
    // ✓ Service keeps running
  }
})
```

**Let exceptions crash** for unrecoverable, process-level failures:
- Database connection pool exhausted
- Critical config missing on startup
- Out of memory

```ts
async function startup() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL required")
    // ✓ Global handler logs it
    // ✓ Process exits
    // ✓ Cloud Run restarts container
  }
}
```

## Labels for Filtering

Labels appear as `logging.googleapis.com/labels` and are **indexed** by Cloud Logging for fast filtering.

### Set labels at construction

```ts
const logger = new CloudRunLogger({
  projectId: "my-project",
  labels: { component: "pubsub-publisher" },
})
```

### Create child loggers with additional labels

```ts
const pubsubLogger = logger.withLabels({ component: "pubsub-publisher" })
const wsLogger = logger.withLabels({ component: "websocket-receiver" })

pubsubLogger.info("Message published")
wsLogger.info("Connection established")
```

### Filter in Cloud Logging

```
labels.component="pubsub-publisher"
labels.component="websocket-receiver" AND severity>=ERROR
```

## Nested Components

For services with multiple sub-components, create a hierarchy of loggers:

```ts
// main.ts - Root logger for the service
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

export const logger = new CloudRunLogger({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
  labels: { service: "data-pipeline" },
})
```

```ts
// pubsub/publisher.ts - Component-specific logger
import { logger as rootLogger } from "../main"

// Inherits service label, adds component label
const logger = rootLogger.withLabels({ component: "pubsub-publisher" })

export class PubSubPublisher {
  publish(data: Buffer) {
    logger.info("Publishing message", { size: data.length })
    // labels: { service: "data-pipeline", component: "pubsub-publisher" }
  }
}
```

```ts
// websocket/receiver.ts - Another component
import { logger as rootLogger } from "../main"

const logger = rootLogger.withLabels({ component: "websocket-receiver" })

export class WebSocketReceiver {
  onMessage(data: string) {
    logger.info("Message received", { length: data.length })
    // labels: { service: "data-pipeline", component: "websocket-receiver" }
  }
}
```

### Filtering nested components

```
# All logs from the data-pipeline service
labels.service="data-pipeline"

# Only pubsub-publisher logs
labels.service="data-pipeline" AND labels.component="pubsub-publisher"

# Errors from any component
labels.service="data-pipeline" AND severity>=ERROR
```

## Express Middleware

The middleware automatically:
- Parses `X-Cloud-Trace-Context` header for trace correlation
- Attaches a request-scoped logger to `req.log`
- Logs incoming requests and responses (optional)
- Skips health check endpoints

### Basic setup

```ts
import express from "express"
import {
  CloudRunLogger,
  loggingMiddleware,
  installGlobalErrorHandlers
} from "@nirvana-tools/cloud-run-logger"

const app = express()
const logger = new CloudRunLogger({
  projectId: "my-project",
  serviceContext: { service: "my-api", version: "1.0.0" },
})

// Install global error handlers for uncaught exceptions
installGlobalErrorHandlers(logger)

app.use(loggingMiddleware({
  projectId: "my-project",
  logger,
}))

app.get("/api/users/:id", async (req, res) => {
  try {
    // req.log has trace context automatically attached
    req.log.info("Fetching user", { userId: req.params.id })

    const user = await fetchUser(req.params.id)
    res.json(user)
  } catch (err) {
    // Logs to Error Reporting with trace correlation
    req.log.error("Failed to fetch user", {
      error: err as Error,
      userId: req.params.id
    })
    res.status(500).json({ error: "Internal error" })
  }
})
```

### Middleware configuration

```ts
app.use(loggingMiddleware({
  // GCP project for trace correlation
  projectId: "my-project",

  // Base logger instance (optional)
  logger: new CloudRunLogger({ projectId: "my-project" }),

  // Auto-log requests (default: true)
  logRequests: true,

  // Auto-log responses with latency (default: true)
  logResponses: true,

  // Headers to exclude from request logs (default shown)
  excludeHeaders: ["authorization", "cookie", "x-api-key"],

  // Paths to skip logging entirely (default shown)
  skipPaths: ["/healthz", "/readyz", "/health", "/ready"],
}))
```

### Adding request IDs

```ts
import { loggingMiddleware, requestIdMiddleware } from "@nirvana-tools/cloud-run-logger"

// Apply request ID middleware AFTER logging middleware
app.use(loggingMiddleware({ projectId: "my-project" }))
app.use(requestIdMiddleware("x-request-id"))

app.get("/api/users", (req, res) => {
  // req.log now includes requestId field
  req.log.info("Processing request")
})
```

### Using with nested components

```ts
// routes/orders.ts
import { Router } from "express"

const router = Router()

router.post("/", async (req, res) => {
  // Create component-specific logger that inherits trace context
  const orderLogger = req.log.withLabels({ component: "orders" })

  orderLogger.info("Creating order", { items: req.body.items.length })

  // Pass to services that need logging
  const order = await orderService.create(req.body, orderLogger)

  res.json(order)
})
```

```ts
// services/order-service.ts
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

export class OrderService {
  async create(data: OrderData, logger: CloudRunLogger) {
    logger.info("Validating order")
    // ...
    logger.info("Order created", { orderId: order.id })
    return order
  }
}
```

## TypeScript Support

The middleware augments the Express `Request` type:

```ts
// Already included in the package
declare global {
  namespace Express {
    interface Request {
      log: CloudRunLogger
      traceContext?: TraceContext
    }
  }
}
```

## Cloud Logging Filters

Common filter patterns:

```
# By service/component
labels.service="data-pipeline"
labels.component="pubsub-publisher"

# By severity
severity>=ERROR
severity=WARNING OR severity=ERROR

# By trace (correlate all logs in a request)
trace="projects/my-project/traces/abc123def456"

# Combined filters
resource.type="cloud_run_revision"
  AND resource.labels.service_name="my-service"
  AND labels.component="auth"
  AND severity>=WARNING

# Text search in message
textPayload:"connection failed"
jsonPayload.message:"connection failed"

# By custom field
jsonPayload.userId="user123"
jsonPayload.orderId="order456"
```

## Output Examples

### Basic log

```json
{"severity":"INFO","message":"User logged in","timestamp":"2024-01-15T10:30:00.000Z","userId":"123"}
```

### With labels

```json
{
  "severity":"INFO",
  "message":"Publishing message",
  "timestamp":"2024-01-15T10:30:00.000Z",
  "logging.googleapis.com/labels":{"service":"data-pipeline","component":"pubsub-publisher"},
  "topicName":"orders"
}
```

### With trace context

```json
{
  "severity":"INFO",
  "message":"Request received",
  "timestamp":"2024-01-15T10:30:00.000Z",
  "logging.googleapis.com/trace":"projects/my-project/traces/abc123def456",
  "logging.googleapis.com/spanId":"789",
  "httpRequest":{"requestMethod":"GET","requestUrl":"/api/users"}
}
```

### Error with stack trace (Error Reporting format)

```json
{
  "severity":"ERROR",
  "message":"Database connection failed",
  "timestamp":"2024-01-15T10:30:00.000Z",
  "stack":"Error: ECONNREFUSED\n    at connect (/app/db.js:42:11)...",
  "error":{
    "name":"ConnectionError",
    "message":"ECONNREFUSED"
  },
  "serviceContext":{
    "service":"my-service",
    "version":"1.2.3"
  }
}
```

Note the top-level `stack` field - this is what Error Reporting uses to detect and group errors.

## Advanced: Explicit Error Reporting

By default, Error Reporting automatically parses your structured logs. For more control, you can use `@google-cloud/error-reporting` directly:

```bash
pnpm add @google-cloud/error-reporting
```

```ts
import { ErrorReporting } from "@google-cloud/error-reporting"
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

const errorReporting = new ErrorReporting({
  projectId: "my-project",
  serviceContext: {
    service: "my-service",
    version: "1.0.0",
  },
})

const logger = new CloudRunLogger({
  projectId: "my-project",
  serviceContext: { service: "my-service", version: "1.0.0" },
})

// Report errors to both logging and Error Reporting API
try {
  await riskyOperation()
} catch (err) {
  logger.error("Operation failed", { error: err as Error })
  errorReporting.report(err)  // Explicit API call
}
```

**When to use explicit Error Reporting:**
- Need guaranteed delivery (doesn't rely on log parsing)
- Want to report errors without logging them
- Need advanced features like user tracking or custom grouping

**For most use cases, structured logging is sufficient.**

## License

MIT
