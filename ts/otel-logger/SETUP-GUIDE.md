# Setup Guide: Advanced Usage Patterns

This guide is for users who need more control than the drop-in API provides.

**Most users should use the drop-in API instead.** See [DROP-IN.md](./DROP-IN.md).

Use this advanced pattern when you need:
- Custom OpenTelemetry configuration
- Shared logger instances across modules
- Request-scoped Express middleware
- Fine-grained control over initialization

## Drop-In API (Recommended)

```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()
```

**That's it.** See [DROP-IN.md](./DROP-IN.md) for complete guide.

## Advanced API (This Guide)

### The 4-File Pattern

```
src/
├── otel.ts         # OpenTelemetry setup (import FIRST)
├── logger.ts       # Logger instance (shared)
├── app.ts          # Express app (service) OR job.ts (job)
└── index.ts        # Entry point
```

### Services: 4-File Setup

**1. Create `src/otel.ts`** (must be imported first)

```typescript
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'

initializeOpenTelemetry({
  // Auto-discovers K_SERVICE and K_REVISION
  
  // Add custom instrumentations
  instrumentations: [
    // Example: database instrumentation
    // new PrismaInstrumentation(),
  ]
})
```

**2. Create `src/logger.ts`** (shared logger)

```typescript
import { createLogger } from '@nirvana-tools/otel-logger'

export const logger = createLogger({
  // Auto-discovers GOOGLE_CLOUD_PROJECT
  
  labels: {
    environment: process.env.NODE_ENV || 'production'
  }
})
```

**3. Create `src/app.ts`** (Express app)

```typescript
import express from 'express'
import { createExpressMiddleware } from '@nirvana-tools/otel-logger'
import { logger } from './logger'

export const app = express()

// Attach logger middleware
app.use(createExpressMiddleware({ logger }))

app.get('/api/users', (req, res) => {
  req.log.info('Fetching users')  // Request-scoped logger
  logger.info('Also works')       // Global logger also includes trace
  
  res.json({ users: [] })
})
```

**4. Create `src/index.ts`** (entry point)

```typescript
import './otel'  // MUST BE FIRST!
import { app } from './app'
import { logger } from './logger'

const PORT = parseInt(process.env.PORT || '8080', 10)

app.listen(PORT, () => {
  logger.info('Service started', { port: PORT })
})
```

### Jobs: 4-File Setup

**1. Create `src/otel.ts`** (same as services)

**2. Create `src/logger.ts`** (same as services)

**3. Create `src/job.ts`**

```typescript
import { createJobLogger } from '@nirvana-tools/otel-logger'

const logger = createJobLogger({
  traceStrategy: 'execution',  // All tasks share same trace
})

export async function runJob() {
  logger.info('Job started')
  
  await processData()
  
  logger.info('Job completed')
}

async function processData() {
  logger.info('Processing batch')
  // ...
}
```

**4. Create `src/index.ts`**

```typescript
import './otel'  // MUST BE FIRST!
import { runJob } from './job'

runJob()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Job failed:', error)
    process.exit(1)
  })
```

## Why Use Advanced API?

### Shared Logger Instance

Export logger from one place, import everywhere:

```typescript
// logger.ts
export const logger = createLogger()

// users-service.ts
import { logger } from './logger'
logger.info('Fetching users')

// orders-service.ts
import { logger } from './logger'
logger.info('Fetching orders')
```

### Request-Scoped Middleware

```typescript
app.use(createExpressMiddleware({ logger }))

app.get('/api', (req, res) => {
  req.log.info('Hello')  // Request-scoped, includes trace
})
```

### Custom OpenTelemetry Configuration

```typescript
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
import { PrismaInstrumentation } from '@prisma/instrumentation'

initializeOpenTelemetry({
  instrumentations: [
    new PrismaInstrumentation(),
  ],
  resourceAttributes: {
    'deployment.environment': process.env.NODE_ENV
  }
})
```

## When to Use Each API

| Use Case | API |
|----------|-----|
| Simple service/job | Drop-in (`init()`) |
| Dozens of services | Drop-in (`init()`) |
| Need shared logger | Advanced (4-file) |
| Custom OTel config | Advanced (4-file) |
| Request-scoped middleware | Advanced (4-file) |

## Complete Examples

See `examples/service/` and `examples/job/` for complete 4-file examples.

## API Reference

### `initializeOpenTelemetry(config?)`

Initializes OpenTelemetry SDK. Must be called before any other imports.

**Config:**
- `serviceName?: string` - Override auto-detected name
- `serviceVersion?: string` - Override auto-detected version
- `instrumentations?: any[]` - Additional instrumentations
- `resourceAttributes?: Record<string, string>` - Custom attributes

### `createLogger(config?): Logger`

Creates a Winston logger with Cloud Logging integration.

**Config:**
- `projectId?: string` - GCP project ID
- `serviceName?: string` - Service name
- `serviceVersion?: string` - Service version
- `level?: string` - Log level
- `local?: boolean` - Use console output
- `labels?: Record<string, string>` - Cloud Logging labels
- petit`defaultMeta?: Record<string, unknown>` - Metadata in all logs

### `createExpressMiddleware(config): Middleware`

Creates Express middleware that attaches logger to `req.log`.

**Config:**
- `logger: winston.Logger` - Logger instance (required)
- `skipPaths?: string[]` - Paths to skip logging

### `createJobLogger(config?): Logger`

Creates a logger for Cloud Run Jobs with synthetic trace context.

**Config:**
- Extends `createLogger` config
- `jobName?: string` - Job name
- `traceStrategy?: 'execution' | 'task'` - Trace grouping
- `installErrorHandlers?: boolean` - Install global handlers

## Troubleshooting

### Import Order is Critical

```typescript
// ✅ CORRECT
import './otel'  // FIRST!
import express from 'express'

// ❌ WRONG
import express from 'express'
import './otel'  // Too late
```

If Express is imported before OpenTelemetry initialization, instrumentation won't work.

### Multiple Logger Instances

Don't create multiple loggers. Create once, export, import everywhere:

```typescript
// ❌ BAD
// user-service.ts
const logger = createLogger()

// order-service.ts
const logger = createLogger()  // Second instance!

// ✅ GOOD
// logger.ts
export const logger = createLogger()

// user-service.ts
import { logger } from './logger'

// order-service.ts
import { logger } from './logger'
```

## Next Steps

- For drop-in usage, see [DROP-IN.md](./DROP-IN.md)
- For complete examples, see `examples/` directory
- For API details, see [README.md](./README.md)
