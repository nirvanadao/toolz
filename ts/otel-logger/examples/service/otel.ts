/**
 * OpenTelemetry setup - MUST be imported FIRST in index.ts
 */
import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'

initializeOpenTelemetry({
  // Auto-discovers K_SERVICE and K_REVISION from Cloud Run
})
