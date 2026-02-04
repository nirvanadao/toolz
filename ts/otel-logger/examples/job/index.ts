/**
 * Entry point - OpenTelemetry MUST be initialized FIRST
 */
import './otel'  // CRITICAL: Must be first import!

import { runJob } from './job'

runJob()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Job failed:', error)
    process.exit(1)
  })
