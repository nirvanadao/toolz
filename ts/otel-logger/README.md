# @nirvana-tools/otel-logger

Drop-in OpenTelemetry and Winston logging for Google Cloud Run services and jobs.

## What It Does

This library provides zero-configuration observability for Cloud Run workloads:

- **Auto-detects** Cloud Run Service vs Job from environment variables
- **Configures OpenTelemetry tracing** with Google Cloud Trace exporter
- **Configures Winston logging** with Google Cloud Logging integration
- **Instruments automatically**:
  - Services: HTTP, Express, and Winston instrumentation
  - Jobs: Winston instrumentation + task metadata (execution ID, task index, attempt count)
- **Local development support**: Set `NODE_ENV=development` for colorized console output

## Installation

```bash
pnpm add @nirvana-tools/otel-logger
```

## Quick Start

```typescript
import { init } from '@nirvana-tools/otel-logger'

// Minimal setup - only version is required
const logger = init({
  version: process.env.GIT_SHA || require('./package.json').version
})

logger.info('Service started')
```

That's it! The library handles everything else automatically.

## Configuration

### `init(config: InitConfig)`

Initialize the logger and OpenTelemetry SDK. Returns a Winston logger instance.

#### `InitConfig` Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `version` | `string` | **Yes** | - | Service/job version. Recommended: git commit SHA via `GIT_SHA` env var |
| `level` | `"silly" \| "debug" \| "verbose" \| "info" \| "warn" \| "error"` | No | `"info"` | Winston log level |
| `labels` | `Record<string, string>` | No | `{}` | Custom labels for Cloud Logging (e.g., `{ team: 'platform', env: 'prod' }`) |
| `instrumentations` | `any[]` | No | `[]` | Additional OpenTelemetry instrumentations to register |

#### Examples

**Basic usage (recommended):**
```typescript
const logger = init({
  version: process.env.GIT_SHA || '1.0.0'
})
```

**With custom log level:**
```typescript
const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  level: 'debug'
})
```

**With custom labels:**
```typescript
const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  labels: {
    team: 'platform',
    environment: process.env.NODE_ENV || 'production'
  }
})
```

**With additional instrumentation:**
```typescript
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'

const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  instrumentations: [new PgInstrumentation()]
})
```

## Structured Logging

Use Winston's structured logging to add metadata to your logs. All metadata is automatically indexed in Cloud Logging.

```typescript
// Log with metadata
logger.info('User logged in', {
  userId: '12345',
  email: 'user@example.com',
  ip: req.ip
})

// Log errors (pass full Error object for Error Reporting)
try {
  await database.query(sql)
} catch (err) {
  logger.error('Database query failed', {
    err,  // Pass full Error object - LoggingWinston extracts stack trace automatically
    query: sql,
    duration: Date.now() - startTime
  })
}

// Log with correlation ID for request tracing
app.use((req, res, next) => {
  req.id = crypto.randomUUID()
  logger.info('Incoming request', {
    requestId: req.id,
    method: req.method,
    path: req.path,
    userAgent: req.get('user-agent')
  })
  next()
})
```

## Error Reporting

For Google Cloud Error Reporting to automatically detect and group errors, you **must pass the full Error object**, not just the message. The `@google-cloud/logging-winston` transport automatically extracts the stack trace and formats it correctly.

### Correct Pattern

```typescript
try {
  await riskyOperation()
} catch (err) {
  // ✓ CORRECT: Pass full Error object using 'err' key
  logger.error('Operation failed', {
    err,  // LoggingWinston extracts stack trace automatically
    userId: user.id,
    operation: 'updateProfile'
  })
}
```

### Alternative: Manual Stack Trace

If you need more control, you can manually include the stack trace:

```typescript
catch (err) {
  logger.error('Operation failed', {
    message: err.message,
    stack: err.stack,  // Manually include stack trace
    userId: user.id
  })
}
```

### What NOT to Do

```typescript
// ✗ WRONG: Only logging message - Error Reporting won't detect this
logger.error('Operation failed', {
  error: err.message  // Missing stack trace!
})

// ✗ WRONG: String interpolation - loses stack trace
logger.error(`Operation failed: ${err.message}`)
```

### Error Reporting Features

When errors are logged correctly:
- **Automatic grouping** by error message and stack trace
- **Occurrence tracking** across all service instances
- **Source code integration** (if you deploy with source maps)
- **Alerts** can be configured for new or frequent errors
- **First/last seen** timestamps for debugging

## How It Works

### Auto-Detection

The library detects Cloud Run workload type from environment variables:

- **Service**: `K_SERVICE` is set → Enables HTTP + Express + Winston instrumentation
- **Job**: `CLOUD_RUN_JOB` is set → Enables Winston instrumentation + adds task metadata

These environment variables are automatically set by Cloud Run. For local development, set one manually:

```bash
# Local service development
export K_SERVICE=my-service
export NODE_ENV=development

# Local job development
export CLOUD_RUN_JOB=my-job
export NODE_ENV=development
```

### Job Metadata

For Cloud Run Jobs, the library automatically reads and logs task metadata:

- `CLOUD_RUN_EXECUTION` - Execution ID
- `CLOUD_RUN_TASK_INDEX` - Task index (for parallel tasks)
- `CLOUD_RUN_TASK_COUNT` - Total number of tasks
- `CLOUD_RUN_TASK_ATTEMPT` - Retry attempt number

This metadata is added to every log entry's `defaultMeta` for easy filtering and debugging.

### Local Development

Set `NODE_ENV=development` to enable colorized console logging instead of JSON output:

```bash
export NODE_ENV=development
export K_SERVICE=my-service
node index.js
```

Output:
```
2026-02-04T10:30:45.123Z info: Service started
2026-02-04T10:30:45.456Z info: User logged in
{
  "userId": "12345",
  "email": "user@example.com"
}
```

## API Reference

### `init(config: InitConfig): winston.Logger`

Initialize OpenTelemetry and Winston. Must be called before `getLogger()`.

**Returns:** Configured Winston logger instance

**Throws:** Error if Cloud Run environment variables are not set

### `getLogger(): winston.Logger`

Get the previously initialized logger instance.

**Returns:** Winston logger instance

**Throws:** Error if `init()` has not been called yet

## Usage Examples

### Express Service

```typescript
import express from 'express'
import { init } from '@nirvana-tools/otel-logger'

const logger = init({
  version: process.env.GIT_SHA || '1.0.0'
})

const app = express()

app.get('/health', (req, res) => {
  logger.debug('Health check')
  res.json({ status: 'ok' })
})

app.post('/api/users', async (req, res) => {
  try {
    logger.info('Creating user', { email: req.body.email })
    const user = await createUser(req.body)
    res.json(user)
  } catch (err) {
    logger.error('Failed to create user', {
      err,  // Pass full Error object for Error Reporting
      email: req.body.email
    })
    res.status(500).json({ error: 'Internal server error' })
  }
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  logger.info('Service listening', { port: PORT })
})
```

### Cloud Run Job

```typescript
import { init } from '@nirvana-tools/otel-logger'

const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  level: 'info'
})

async function processTask() {
  logger.info('Task started')

  try {
    const results = await fetchAndProcessData()
    logger.info('Task completed', {
      recordsProcessed: results.length,
      duration: results.duration
    })
  } catch (err) {
    logger.error('Task failed', { err })  // Pass full Error object
    process.exit(1) // Cloud Run will retry based on task attempt config
  }
}

processTask()
```

### With Custom Labels

```typescript
import { init } from '@nirvana-tools/otel-logger'

const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  labels: {
    team: 'platform',
    component: 'api-gateway',
    environment: process.env.NODE_ENV || 'production'
  }
})

// All logs will include these labels in Cloud Logging for filtering
logger.info('Deployment started')
```

### With Custom Log Level

```typescript
import { init } from '@nirvana-tools/otel-logger'

const isDev = process.env.NODE_ENV === 'development'

const logger = init({
  version: process.env.GIT_SHA || '1.0.0',
  level: isDev ? 'debug' : 'info'
})

logger.debug('This only appears in development')
logger.info('This appears in all environments')
```

## Best Practices

1. **Version from Git SHA**: Use `GIT_SHA` environment variable for accurate version tracking in traces and logs:
   ```dockerfile
   ARG GIT_SHA
   ENV GIT_SHA=${GIT_SHA}
   ```

   Build with:
   ```bash
   docker build --build-arg GIT_SHA=$(git rev-parse HEAD) .
   ```

2. **Initialize early**: Call `init()` at the top of your entry file, before other imports that might make HTTP calls or database connections.

3. **Use structured logging**: Always pass metadata objects instead of string concatenation:
   ```typescript
   // Good
   logger.info('User action', { userId, action: 'login' })

   // Bad
   logger.info(`User ${userId} performed action login`)
   ```

4. **Log errors correctly for Error Reporting**: Always pass the full Error object using the `err` key:
   ```typescript
   // Pass full Error object - stack trace extracted automatically
   logger.error('Operation failed', {
     err,  // IMPORTANT: Use 'err' key, not 'error'
     userId,
     operation: 'updateProfile'
   })
   ```

5. **Local development**: Set `NODE_ENV=development` for readable console output during development.

## License

MIT
