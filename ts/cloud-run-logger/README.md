# @nirvana-tools/cloud-run-logger

Production-grade structured JSON logging for Google Cloud Run with trace correlation and Express middleware.

## Features

- **Structured JSON output** - Single-line JSON logs that Cloud Logging parses automatically
- **All GCP severity levels** - DEBUG, INFO, NOTICE, WARNING, ERROR, CRITICAL, ALERT, EMERGENCY
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

  // Minimum severity to output (default: "DEBUG")
  minSeverity: "INFO",

  // Fields included in every log entry
  defaultFields: {
    service: "api-gateway",
    version: "1.2.3",
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

## Logging Errors

```ts
try {
  await riskyOperation()
} catch (err) {
  logger.logError("ERROR", "Operation failed", err as Error, {
    operationId: "abc123",
  })
}
// Includes error.name, error.message, and error.stack
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
import { CloudRunLogger, loggingMiddleware } from "@nirvana-tools/cloud-run-logger"

const app = express()
const logger = new CloudRunLogger({ projectId: "my-project" })

app.use(loggingMiddleware({
  projectId: "my-project",
  logger,
}))

app.get("/api/users/:id", (req, res) => {
  // req.log has trace context automatically attached
  req.log.info("Fetching user", { userId: req.params.id })

  // All logs in this request share the same trace ID
  res.json({ id: req.params.id, name: "Alice" })
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

### Error with stack trace

```json
{
  "severity":"ERROR",
  "message":"Database connection failed",
  "timestamp":"2024-01-15T10:30:00.000Z",
  "error":{
    "name":"ConnectionError",
    "message":"ECONNREFUSED",
    "stack":"ConnectionError: ECONNREFUSED\n    at connect (/app/db.js:42:11)..."
  }
}
```

## License

MIT
