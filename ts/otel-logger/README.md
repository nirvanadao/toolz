# @nirvana-tools/otel-logger

**Drop-in OpenTelemetry logging for Google Cloud Run services and jobs.**

One line of code gives you automatic trace correlation, distributed tracing, and Cloud Logging integration.

```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // That's it!

logger.info('Hello world')  // Automatically includes trace context
```

## Why This Package?

**Problem:** You want distributed tracing and log correlation across dozens of Cloud Run services/jobs, but:
- OpenTelemetry setup is complex (initialization order matters)
- Logs need manual wiring to include trace context
- Repeating setup across many services is error-prone

**Solution:** Single-line initialization that auto-discovers Cloud Run environment and configures everything.

## Features

✅ **Drop-in simplicity** - One import, everything configured  
✅ **Automatic trace correlation** - All logs include trace IDs via OpenTelemetry  
✅ **Distributed tracing** - Traces propagate across service calls automatically  
✅ **Works for services AND jobs** - HTTP services and background jobs  
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
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // FIRST LINE!

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
    console.error('Job failed:', error)
    process.exit(1)
  })
```

Deploy:
```bash
gcloud run jobs deploy my-job --source . --region us-central1 --tasks 10
```

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

Since jobs don't have HTTP requests, `init()` detects the job environment and:
1. Generates synthetic trace ID from `CLOUD_RUN_EXECUTION`
2. Creates Winston child logger with trace fields
3. All logs include the same trace ID
4. Filter by `labels.execution` in Cloud Logging

## What Gets Auto-Discovered?

`init()` automatically reads these Cloud Run environment variables:

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

Most services don't need configuration, but you can customize:

```typescript
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

```typescript
// otel-setup.ts - initialize first
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
initializeOpenTelemetry()

// logger.ts - create logger
import { createLogger } from '@nirvana-tools/otel-logger'
export const logger = createLogger()

// app.ts - use middleware
import { createExpressMiddleware } from '@nirvana-tools/otel-logger'
import { logger } from './logger'

app.use(createExpressMiddleware({ logger }))

app.get('/api', (req, res) => {
  req.log.info('Hello')  // req.log is request-scoped
  logger.info('Also works')  // Global logger also includes trace
})
```

See `examples/service/` and `examples/job/` for the 4-file pattern.

## API Reference

### `init(config?): Logger`

Drop-in initialization. Returns Winston logger instance.

**Config options:**
- `projectId?: string` - GCP project ID (default: `GOOGLE_CLOUD_PROJECT`)
- `serviceName?: string` - Service name (default: `K_SERVICE` or `CLOUD_RUN_JOB`)
- `level?: string` - Log level (default: `"info"`)
- `labels?: Record<string, string>` - Cloud Logging labels
- `instrumentations?: any[]` - Additional OTel instrumentations

### `getLogger(): Logger`

Get the logger instance after `init()` has been called.

```typescript
// some-file.ts
import { getLogger } from '@nirvana-tools/otel-logger'

const logger = getLogger()
logger.info('Hello')
```

## For Dozens of Services

This package was designed for repeatability. To use across many services:

1. **Copy package.json dependencies** to each service
2. **Add one line** to each entry point: `import { init } from '@nirvana-tools/otel-logger'; const logger = init()`
3. **Deploy** - everything auto-configured

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
