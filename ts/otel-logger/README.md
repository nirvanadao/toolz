# @nirvana-tools/otel-logger

**Drop-in OpenTelemetry logging for Google Cloud Run services and jobs.**

One line of code gives you automatic trace correlation, distributed tracing, and Cloud Logging integration.

**For HTTP services:**
```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // Service mode: HTTP + Express + Winston instrumentation

logger.info('Hello world')  // Automatically includes trace context
```

**For jobs:**
```typescript
import { initJob } from '@nirvana-tools/otel-logger'
const logger = initJob()  // Job mode: Winston only (no HTTP overhead)

logger.info('Job running')  // Automatically includes synthetic trace context
```

## Why This Package?

**Problem:** You want distributed tracing and log correlation across dozens of Cloud Run services/jobs, but:
- OpenTelemetry setup is complex (initialization order matters)
- Logs need manual wiring to include trace context
- Jobs get unnecessary HTTP instrumentation overhead
- Repeating setup across many services is error-prone

**Solution:** Explicit initialization functions (`init()` for services, `initJob()` for jobs) that auto-discover Cloud Run environment and configure everything with the right instrumentation.

## Features

✅ **Drop-in simplicity** - One import, everything configured
✅ **Explicit intent** - `init()` for services, `initJob()` for jobs
✅ **Automatic trace correlation** - All logs include trace IDs via OpenTelemetry
✅ **Distributed tracing** - Traces propagate across service calls automatically
✅ **Optimized for workload type** - Services get HTTP instrumentation, jobs don't
✅ **Cloud Logging integration** - Winston + @google-cloud/logging-winston
✅ **Error Reporting** - Proper serviceContext for automatic error grouping
✅ **Local dev mode** - Pretty-printed console output
✅ **Auto-discovery** - Reads all Cloud Run environment variables  

## Quick Start

### Installation

```bash
pnpm add @nirvana-tools/otel-logger \
         @opentelemetry/api \
         @opentelemetry/sdk-node \
         @opentelemetry/resources \
         @opentelemetry/semantic-conventions \
         @opentelemetry/instrumentation-http \
         @opentelemetry/instrumentation-express \
         @opentelemetry/instrumentation-winston
```

### Cloud Run Service (Express)

```typescript
// index.ts
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // FIRST LINE!

import express from 'express'

const app = express()

app.get('/api/users', async (req, res) => {
  logger.info('Fetching users', { userId: req.query.userId })
  
  const users = await fetchUsers()
  res.json({ users })
})

app.listen(parseInt(process.env.PORT || '8080'), () => {
  logger.info('Service started')
})

async function fetchUsers() {
  // Even nested function calls automatically include trace context!
  logger.info('Querying database')
  return []
}
```

Deploy:
```bash
gcloud run deploy my-service --source . --region us-central1
```

### Cloud Run Job

```typescript
// index.ts
import { initJob } from '@nirvana-tools/otel-logger'
const logger = initJob()  // FIRST LINE! Job mode: Winston only

async function runJob() {
  logger.info('Job started', {
    taskIndex: process.env.CLOUD_RUN_TASK_INDEX
  })

  await processData()

  logger.info('Job completed')
}

async function processData() {
  // All logs automatically include synthetic trace context
  logger.info('Processing batch')
  // ...
}

runJob()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Job failed', { error })
    process.exit(1)
  })
```

Deploy:
```bash
gcloud run jobs deploy my-job --source . --region us-central1 --tasks 10
```

## Service vs Job Initialization

This package provides two explicit initialization functions for different Cloud Run workload types:

### `init()` - For HTTP Services (Cloud Run Services)

**Use for:**
- Cloud Run services (Express, Koa, Fastify, etc.)
- Any service that handles HTTP requests
- Services that need distributed tracing across HTTP calls

**What it does:**
- Sets up HTTP + Express + Winston instrumentation
- Enables automatic trace propagation via HTTP headers
- Creates spans for each HTTP request and route
- All logs automatically include trace context from incoming requests

```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // Service mode

import express from 'express'
const app = express()

app.get('/api', (req, res) => {
  logger.info('Request received')  // Includes trace from HTTP request
  res.json({ ok: true })
})
```

### `initJob()` - For Jobs (Cloud Run Jobs)

**Use for:**
- Cloud Run jobs (batch processing, data pipelines, scheduled tasks)
- Any workload that doesn't handle HTTP requests
- Workloads where you want minimal overhead

**What it does:**
- Sets up Winston instrumentation only (no HTTP/Express overhead)
- Creates synthetic trace IDs from `CLOUD_RUN_EXECUTION` environment variable
- All logs include trace context for Cloud Logging correlation
- Much lighter than `init()` - no unnecessary HTTP instrumentation

```typescript
import { initJob } from '@nirvana-tools/otel-logger'
const logger = initJob()  // Job mode (no HTTP overhead)

async function main() {
  logger.info('Processing data')  // Includes synthetic trace from execution ID
  await processData()
  logger.info('Done')
}
```

### Why Separate Functions?

**Explicit intent:** When you read code, it's immediately clear which workload type you're dealing with.

**Performance:** Jobs don't waste resources loading HTTP/Express instrumentation they'll never use.

**Best practices:** Each workload gets exactly the instrumentation it needs - nothing more, nothing less.

### Edge Case: Job with Health Check Endpoint

If you have a job that also serves a health check endpoint (rare), use `init()` instead of `initJob()`. The HTTP instrumentation is needed for the health check requests.

## How It Works

### Automatic Trace Correlation

The magic happens via OpenTelemetry instrumentation:

1. **HTTP instrumentation** creates a span for each incoming request
2. **Winston instrumentation** reads the active span context
3. **Automatically injects** `trace_id` and `span_id` into every log
4. **Cloud Logging** correlates logs by trace ID

**Result:** Every `logger.info()` call within a request automatically includes trace context. No manual wiring needed!

### Distributed Tracing

When Service A calls Service B:
1. OpenTelemetry HTTP instrumentation automatically propagates trace context in HTTP headers
2. Service B's HTTP instrumentation extracts the trace context
3. All logs in both services share the same trace ID
4. View the entire request flow in Cloud Trace

**No manual header forwarding required!**

### Jobs (No HTTP Requests)

Since jobs don't have HTTP requests, `initJob()` handles tracing differently:
1. Generates synthetic trace ID from `CLOUD_RUN_EXECUTION`
2. Creates Winston child logger with trace fields for Cloud Logging
3. All logs within the same execution share the same trace ID
4. Filter by `labels.execution` in Cloud Logging to see all logs from a job execution

**Important:** The synthetic traces are metadata fields for Cloud Logging correlation only. They don't create actual OpenTelemetry spans, but OTEL is still initialized for Winston instrumentation.

### Manual Trace Propagation (Pub/Sub, Task Queues)

OpenTelemetry automatically propagates trace context for HTTP requests, but async work (Pub/Sub, Task Queues) requires manual propagation.

**Example: Pub/Sub trace propagation**

```typescript
import { init, trace } from '@nirvana-tools/otel-logger'
import { PubSub } from '@google-cloud/pubsub'

const logger = init()
const pubsub = new PubSub()

// Publisher: Extract and attach trace context
app.post('/events', async (req, res) => {
  logger.info('Publishing event')

  const span = trace.getActiveSpan()
  const traceId = span?.spanContext().traceId || ''
  const spanId = span?.spanContext().spanId || ''

  await pubsub.topic('events').publish(Buffer.from(JSON.stringify(data)), {
    attributes: {
      'x-cloud-trace-context': `${traceId}/${spanId}`,
    },
  })

  res.json({ ok: true })
})

// Subscriber: Restore trace context
subscription.on('message', async (message) => {
  const traceContext = message.attributes['x-cloud-trace-context']
  const [traceId, spanId] = traceContext?.split('/') || []

  // Create child logger with trace fields for Cloud Logging correlation
  const childLogger = logger.child({
    'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}`,
    'logging.googleapis.com/spanId': spanId,
  })

  childLogger.info('Processing message', { messageId: message.id })

  // Process message...
  message.ack()
})
```

**Note**: This creates a new trace in the subscriber, but Cloud Logging will correlate logs by trace ID. For full span linking (showing subscriber as child span in Cloud Trace), you'd need to use OpenTelemetry's context propagation APIs to restore the parent span context.

## What Gets Auto-Discovered?

Both `init()` and `initJob()` automatically read these Cloud Run environment variables:

**Services:**
- `K_SERVICE` → service name
- `K_REVISION` → version
- `GOOGLE_CLOUD_PROJECT` → project ID
- `PORT` → HTTP port

**Jobs:**
- `CLOUD_RUN_JOB` → job name
- `CLOUD_RUN_EXECUTION` → execution ID
- `CLOUD_RUN_TASK_INDEX` → task number
- `CLOUD_RUN_TASK_COUNT` → total tasks
- `GOOGLE_CLOUD_PROJECT` → project ID

**Both:**
- `NODE_ENV=development` → enables local console logging

## Configuration (Optional)

Most services don't need configuration, but you can customize both `init()` and `initJob()`:

```typescript
// For services
import { init } from '@nirvana-tools/otel-logger'

const logger = init({
  // Override auto-detected project ID
  projectId: 'my-project',

  // Override auto-detected service name
  serviceName: 'my-custom-name',

  // Add indexed labels for filtering in Cloud Logging
  labels: {
    team: 'platform',
    component: 'api-gateway',
    environment: 'prod'
  },

  // Set log level
  level: 'debug',

  // Add custom OpenTelemetry instrumentations
  instrumentations: [
    // Example: add database instrumentation
    // new PrismaInstrumentation(),
  ]
})
```

```typescript
// For jobs
import { initJob } from '@nirvana-tools/otel-logger'

const logger = initJob({
  projectId: 'my-project',
  serviceName: 'my-job',
  labels: { team: 'data' },
  level: 'info',
  // Jobs can also add custom instrumentations (but not HTTP/Express)
  instrumentations: [/* ... */]
})
```

## Querying Logs in Cloud Logging

**All logs from a specific request:**
```
trace="projects/my-project/traces/abc123..."
```

**All logs from a service:**
```
resource.labels.service_name="my-service"
```

**All logs from a job execution:**
```
labels.execution="job-execution-12345"
```

**All errors:**
```
severity>=ERROR
```

**Custom labels:**
```
labels.team="platform"
labels.component="api-gateway"
```

## Local Development

```bash
NODE_ENV=development node dist/index.js
```

Output will be colorized console logs instead of JSON:
```
2026-02-03T10:30:45.123Z info: Service started
{
  port: 8080,
  service: "my-service"
}
```

## Advanced Usage

If you need more control, use the advanced API:

### Service with Advanced Setup

```typescript
// otel-setup.ts - initialize first
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
initializeOpenTelemetry({
  serviceName: 'my-service',
  workloadType: 'service'  // Explicit service mode
})

// logger.ts - create logger
import { createLogger } from '@nirvana-tools/otel-logger'
export const logger = createLogger()

// app.ts - use logger
import express from 'express'
import { logger } from './logger'

const app = express()

app.get('/api', (req, res) => {
  logger.info('Request received')  // Automatically includes trace context!
  res.json({ ok: true })
})
```

### Job with Advanced Setup

```typescript
// otel-setup.ts - initialize first
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
initializeOpenTelemetry({
  serviceName: 'my-job',
  workloadType: 'job'  // Explicit job mode (Winston only)
})

// logger.ts - create job logger
import { createJobLogger } from '@nirvana-tools/otel-logger'
export const logger = createJobLogger({
  jobName: 'my-job',
  traceStrategy: 'execution'
})

// job.ts - use logger
import { logger } from './logger'

async function main() {
  logger.info('Job started')
  await processData()
  logger.info('Job completed')
}
```

See `examples/service/` and `examples/job/` for the 4-file pattern.

## API Reference

### `init(config?): Logger`

Drop-in initialization for HTTP services. Returns Winston logger instance.

Sets up HTTP + Express + Winston instrumentation for distributed tracing.

**Config options:**
- `projectId?: string` - GCP project ID (default: `GOOGLE_CLOUD_PROJECT`)
- `serviceName?: string` - Service name (default: `K_SERVICE`)
- `level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"` - Log level (default: `"info"`)
- `labels?: Record<string, string>` - Cloud Logging labels
- `instrumentations?: any[]` - Additional OTel instrumentations

### `initJob(config?): Logger`

Drop-in initialization for Cloud Run jobs. Returns Winston logger instance.

Sets up Winston instrumentation only (no HTTP/Express overhead). Creates synthetic trace IDs from `CLOUD_RUN_EXECUTION`.

**Config options:**
- `projectId?: string` - GCP project ID (default: `GOOGLE_CLOUD_PROJECT`)
- `serviceName?: string` - Job name (default: `CLOUD_RUN_JOB`)
- `level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"` - Log level (default: `"info"`)
- `labels?: Record<string, string>` - Cloud Logging labels
- `instrumentations?: any[]` - Additional OTel instrumentations

### `getLogger(): Logger`

Get the logger instance after `init()` or `initJob()` has been called.

```typescript
// some-file.ts
import { getLogger } from '@nirvana-tools/otel-logger'

const logger = getLogger()
logger.info('Hello')
```

### Advanced API

#### `initializeOpenTelemetry(config?): NodeSDK`

Low-level OpenTelemetry initialization with explicit workload type control.

**Config options:**
- `serviceName?: string` - Service/job name
- `serviceVersion?: string` - Version
- `workloadType?: "service" | "job"` - Explicit workload type (default: auto-detected from `K_SERVICE` or `CLOUD_RUN_JOB`)
- `instrumentations?: any[]` - Additional instrumentations
- `resourceAttributes?: Record<string, string>` - Custom resource attributes

#### `createLogger(config?): Logger`

Creates a Winston logger for services. Use with `initializeOpenTelemetry()`.

#### `createJobLogger(config?): Logger`

Creates a Winston logger for jobs with synthetic traces. Use with `initializeOpenTelemetry({ workloadType: 'job' })`.

**Config options:**
- `jobName?: string` - Job name (default: `CLOUD_RUN_JOB`)
- `traceStrategy?: "execution" | "task"` - Trace grouping strategy (default: `"execution"`)
- `installErrorHandlers?: boolean` - Install global error handlers (default: `true`)
- All options from `createLogger()`

## For Dozens of Services

This package was designed for repeatability. To use across many services and jobs:

1. **Copy package.json dependencies** to each service/job
2. **Add one line** to each entry point:
   - Services: `import { init } from '@nirvana-tools/otel-logger'; const logger = init()`
   - Jobs: `import { initJob } from '@nirvana-tools/otel-logger'; const logger = initJob()`
3. **Deploy** - everything auto-configured

The explicit `init()` vs `initJob()` pattern makes it immediately clear which workload type you're dealing with when reading code across dozens of services.

See [DROP-IN.md](./DROP-IN.md) for the complete pattern.

## Comparison with cloud-run-logger

| Feature | cloud-run-logger | otel-logger |
|---------|-----------------|-------------|
| Trace correlation | Manual (`req.log` only) | Automatic (all logs) |
| Distributed tracing | No | Yes (OpenTelemetry) |
| Dependencies | 0 runtime | Winston + OTel |
| Setup | Simple (2 files) | Drop-in (1 line) |
| Best for | Simple apps, no distributed tracing | Microservices, full observability |

**Use otel-logger when:**
- Building microservices that call each other
- Want distributed tracing across services
- Need automatic trace correlation
- Setting up observability stack anyway

**Use cloud-run-logger when:**
- Simple independent services
- Want zero dependencies
- Don't need distributed tracing

## Troubleshooting

### Logs don't include trace IDs

**Cause:** OpenTelemetry not initialized before other imports.

**Solution:** Make sure `import { init } from '@nirvana-tools/otel-logger'` and `const logger = init()` are the **first lines** in your entry point, before any other imports.

```typescript
// ✅ CORRECT
import { init } from '@nirvana-tools/otel-logger'
const logger = init()
import express from 'express'  // After init()

// ❌ WRONG
import express from 'express'  // Before init()
import { init } from '@nirvana-tools/otel-logger'
const logger = init()
```

### "projectId is required" error

**Cause:** `GOOGLE_CLOUD_PROJECT` environment variable not set (usually only happens locally).

**Solution:** Pass `projectId` explicitly:
```typescript
const logger = init({ projectId: 'my-project' })
```

Or set environment variable:
```bash
export GOOGLE_CLOUD_PROJECT=my-project
```

### Local development shows JSON logs

**Cause:** `NODE_ENV` not set to `"development"`.

**Solution:**
```bash
NODE_ENV=development node dist/index.js
```

Or force local mode:
```typescript
const logger = init({ local: true })
```

## Examples

- `examples/drop-in-service.ts` - Single-file service example
- `examples/drop-in-job.ts` - Single-file job example
- `examples/service/` - Advanced 4-file service pattern
- `examples/job/` - Advanced 4-file job pattern

## Documentation

- [DROP-IN.md](./DROP-IN.md) - Complete guide for dozens of services
- [SETUP-GUIDE.md](./SETUP-GUIDE.md) - Advanced usage patterns

## License

MIT
