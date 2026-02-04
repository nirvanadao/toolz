# Drop-In Usage Guide (For Dozens of Services/Jobs)

Since you're on Cloud Run (managed platform) and want easy repeatability, use the **drop-in API**.

## The Drop-In Pattern

**One line** initializes everything:

```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()
```

That's it. Auto-discovers all Cloud Run environment variables, sets up OpenTelemetry, creates logger.

## Services: Single-File Pattern

**For a Cloud Run Service, you only need ONE file:**

```typescript
// index.ts
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // FIRST LINE - that's it!

import express from 'express'

const app = express()

app.get('/api/users', async (req, res) => {
  logger.info('Fetching users')  // Automatically includes trace!
  res.json({ users: [] })
})

app.listen(parseInt(process.env.PORT || '8080'), () => {
  logger.info('Service started')
})
```

**Deploy:**
```bash
gcloud run deploy my-service --source . --region us-central1
```

**Done.** Repeat for all services.

## Jobs: Single-File Pattern

**For a Cloud Run Job, you only need ONE file:**

```typescript
// index.ts
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // FIRST LINE - that's it!

async function runJob() {
  logger.info('Job started')
  
  // Do work...
  
  logger.info('Job completed')
}

runJob()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Job failed:', error)
    process.exit(1)
  })
```

**Deploy:**
```bash
gcloud run jobs deploy my-job --source . --region us-central1 --tasks 10
```

**Done.** Repeat for all jobs.

## What Gets Auto-Discovered?

The `init()` function automatically picks up:

**From Cloud Run environment:**
- `K_SERVICE` or `CLOUD_RUN_JOB` → service name
- `K_REVISION` or `JOB_VERSION` → version
- `GOOGLE_CLOUD_PROJECT` → project ID
- `NODE_ENV` → local vs production mode

**OpenTelemetry setup:**
- HTTP instrumentation (for distributed tracing)
- Express instrumentation (creates spans per route)
- Winston instrumentation (injects trace IDs into logs)

**Result:** Every `logger.info()` call automatically includes trace context!

## For Dozens of Services

Since you want to do this dozens of times, here's the checklist:

### 1. Add to package.json

```json
{
  "dependencies": {
    "@nirvana-tools/otel-logger": "workspace:*",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-node": "^0.57.0",
    "@opentelemetry/resources": "^1.28.0",
    "@opentelemetry/semantic-conventions": "^1.28.0",
    "@opentelemetry/instrumentation-http": "^0.56.0",
    "@opentelemetry/instrumentation-express": "^0.45.0",
    "@opentelemetry/instrumentation-winston": "^0.43.0",
    "express": "^4.18.0"
  }
}
```

### 2. Create index.ts

```typescript
import { init } from '@nirvana-tools/otel-logger'
const logger = init()

// Rest of your app...
```

### 3. Deploy

```bash
gcloud run deploy SERVICE_NAME --source . --region us-central1
```

### 4. Repeat

Copy `package.json` and `index.ts` pattern to next service. That's it.

## Customization (Optional)

If you need custom labels or instrumentations:

```typescript
import { init } from '@nirvana-tools/otel-logger'

const logger = init({
  labels: {
    team: 'platform',
    component: 'api-gateway'
  },
  instrumentations: [
    // Add custom instrumentation (e.g., database)
    // new PrismaInstrumentation(),
  ]
})
```

## Filtering Logs in Cloud Logging

**All logs from a service:**
```
resource.labels.service_name="my-service"
```

**All logs from a specific request (trace):**
```
trace="projects/my-project/traces/abc123..."
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

Outputs pretty-printed colorized logs to console instead of JSON.

## Comparison: Drop-In vs Advanced API

| Aspect | Drop-In (`init()`) | Advanced API |
|--------|-------------------|--------------|
| Setup | 1 line | 4 files (otel.ts, logger.ts, app.ts, index.ts) |
| Complexity | Minimal | More control |
| Best for | Dozens of services | Custom needs |

For your use case (dozens of services/jobs on Cloud Run), **use drop-in**.

## Complete Example

See `examples/drop-in-service.ts` and `examples/drop-in-job.ts` for complete working examples.

## Why This Works for Distributed Tracing

Even though it's "drop-in," you still get full distributed tracing:

1. OpenTelemetry HTTP instrumentation propagates trace context across service calls
2. When Service A calls Service B, trace ID is automatically propagated
3. All logs in both services share the same trace ID
4. View the entire request flow in Cloud Trace

**No manual header forwarding needed!**

## Next Steps

1. Copy `examples/drop-in-service.ts` or `examples/drop-in-job.ts`
2. Adjust to your needs (add routes, business logic, etc.)
3. Deploy: `gcloud run deploy ...`
4. Check logs in Cloud Logging (automatically correlated!)
5. View traces in Cloud Trace (automatically captured!)
6. Repeat for next service/job

That's it. Same pattern, every time. 🎉
