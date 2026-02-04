/**
 * Shared logger instance - import and use throughout your app
 */
import { createLogger } from '@nirvana-tools/otel-logger'

export const logger = createLogger({
  // Auto-discovers GOOGLE_CLOUD_PROJECT
  labels: {
    environment: process.env.NODE_ENV || 'production'
  }
})
