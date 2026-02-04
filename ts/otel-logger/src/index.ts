/**
 * @nirvana-tools/otel-logger
 *
 * Explicit OpenTelemetry logging for Cloud Run.
 *
 * Two functions:
 * - initService() for Cloud Run services (HTTP)
 * - initJob() for Cloud Run jobs (batch processing)
 *
 * All parameters explicit, no env var reading.
 */

export { initService, initJob, getLogger } from "./init"
export type { Logger } from "winston"
