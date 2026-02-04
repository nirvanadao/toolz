/**
 * @nirvana-tools/otel-logger
 *
 * Drop-in OpenTelemetry logging for Google Cloud Run.
 *
 * One function that auto-detects service vs job:
 * - Service (K_SERVICE): HTTP + Express + Winston instrumentation
 * - Job (CLOUD_RUN_JOB): Winston only (no HTTP overhead)
 *
 * @example
 * ```ts
 * import { init } from '@nirvana-tools/otel-logger'
 * const logger = init()
 *
 * // Works for both services and jobs!
 * logger.info('Hello')
 * ```
 */

export { init, getLogger, InitConfig } from "./init"

// Re-export winston Logger type for convenience
export type { Logger } from "winston"
