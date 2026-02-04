Observability Integration Guide

This guide explains how to integrate the shared @samsara/observability package into your Cloud Run Services and Jobs.

1. Installation

Install the shared package in your service.

npm install @samsara/observability

2. Create the Instrumentation Stub

Create a file at src/instrumentation.ts. This file acts as the entry point for the OpenTelemetry process. It imports the shared logic and initializes it before your app starts.

Standard Usage:

// src/instrumentation.ts
import { initInstrumentation } from '@samsara/observability/instrumentation';

// Initialize with defaults (auto-detects Service Name & Version)
initInstrumentation();

Advanced Usage (Manual Overrides):

// src/instrumentation.ts
import { initInstrumentation } from '@samsara/observability/instrumentation';

initInstrumentation({
// Force a specific service name (useful for monolithic repos)
serviceName: 'order-processor-worker',

// Custom sampling (e.g., sample 50% of traces for this critical service)
samplingRatio: 0.5,

// Optional: Disable specific instrumentations if they cause issues
// instrumentations: [ ... ]
});

3. Deployment Configuration (Dockerfile)

You must load the instrumentation file before your application starts using the Node.js --require flag.

Update your Dockerfile CMD to point to the compiled version of your stub.

# Assuming your build outputs to ./dist

# We require ./dist/instrumentation.js BEFORE ./dist/main.js

CMD ["node", "--require", "./dist/instrumentation.js", "./dist/main.js"]

4. Local Development

To run locally with tracing enabled (prints to console/stub), you can use ts-node or tsx to load the TypeScript file directly.

Using ts-node:

node --require ts-node/register src/instrumentation.ts src/main.ts

# OR if strictly using modules

node --loader ts-node/esm --require ./src/instrumentation.ts ./src/main.ts

Using tsx (Faster):

npx tsx --import ./src/instrumentation.ts ./src/main.ts

5. Required Environment Variables

Ensure these variables are set in your Cloud Run configuration or .env file.

Variable

Required

Description

GOOGLE_CLOUD_PROJECT

YES

Your GCP Project ID. Traces will not export without this.

K_SERVICE

No

Auto-populated by Cloud Run. Used for Service Name.

K_REVISION

No

Auto-populated by Cloud Run. Used for Version.

APP_VERSION

No

Recommended. Set this in Terraform to a Git SHA or SemVer to override K_REVISION.

TRACE_SAMPLING_RATIO

No

Default 0.1. Controls sampling rate (0.0 to 1.0).

6. Verification

When the service starts, check the logs for:

[Observability] Instrumentation started for [your-service-name] v[version]

If you see this, OpenTelemetry is active and hooking into your application.

7. Special: Cloud Run Jobs Pattern

Unlike Services, Jobs do not have an incoming HTTP request to automatically start a trace. You must manually start a "Root Span" in your job's entry point.

src/job.ts:

import { trace } from '@opentelemetry/api';
import { logger } from './lib/logger'; // Assuming you use the logger from the guide

const tracer = trace.getTracer('job-runner');

async function main() {
// 1. Start the "Root Span" for the Job
return tracer.startActiveSpan('job_execution', async (span) => {
try {
logger.info('Starting Job');

      // All subsequent calls (DB, HTTP) will be children of this span
      await processTasks();

      logger.info('Job Complete');
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: 2 }); // Error
      logger.error(err as Error);
      process.exit(1);
    } finally {
      // 2. CRITICAL: End the span and force flush before exit
      span.end();

      // Give the exporter time to flush (Cloud Run freezes CPU on exit)
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

});
}

main();

8. Manual Tracing (Creating Spans)

To manually track a specific function or block of code, retrieve the tracer from the global API.

1. Import trace from @opentelemetry/api:
   You do NOT import this from your instrumentation file.

import { trace } from '@opentelemetry/api';

// The string argument is the name of the library/component creating the trace
const tracer = trace.getTracer('order-service');

2. Use startActiveSpan:

// Example: Wrapping a heavy calculation
async function calculateRisk() {
return tracer.startActiveSpan('calculate_risk', async (span) => {
try {
span.setAttribute('user_id', '12345'); // Add metadata

      const result = await heavyMath();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end(); // MUST allow the span to end
    }

});
}
