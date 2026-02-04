/**
 * OpenTelemetry setup - MUST be imported FIRST in index.ts
 */
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'

initializeOpenTelemetry({
  // Auto-discovers CLOUD_RUN_JOB and JOB_VERSION from Cloud Run
})
