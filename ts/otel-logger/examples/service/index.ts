/**
 * Entry point - OpenTelemetry MUST be initialized FIRST
 */
import './otel'  // CRITICAL: Must be first import!

import { app } from './app'
import { logger } from './logger'

const PORT = parseInt(process.env.PORT || '8080', 10)

app.listen(PORT, () => {
  logger.info('Service started', { port: PORT })
})
