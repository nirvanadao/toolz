import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"

/**
 * Configuration for OpenTelemetry initialization.
 */
export interface OpenTelemetryConfig {
  /**
   * Service name for tracing.
   * @default process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || "unknown"
   */
  serviceName?: string

  /**
   * Service version for tracing.
   * @default process.env.K_REVISION || process.env.JOB_VERSION || "unknown"
   */
  serviceVersion?: string

  /**
   * Additional instrumentations to enable beyond the defaults.
   * By default, HTTP, Express, and Winston are instrumented.
   */
  instrumentations?: any[]

  /**
   * Custom resource attributes to add to all telemetry.
   */
  resourceAttributes?: Record<string, string>
}

/**
 * Initialize OpenTelemetry SDK with sensible defaults for Cloud Run.
 *
 * IMPORTANT: This MUST be called before any other imports in your application,
 * ideally as the very first thing in your entry point.
 *
 * This sets up:
 * - Automatic HTTP/Express instrumentation for trace propagation
 * - Winston instrumentation for automatic trace correlation in logs
 * - Cloud Trace exporter (when running on GCP)
 *
 * @example
 * ```ts
 * // index.ts - FIRST lines of your application
 * import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
 *
 * initializeOpenTelemetry({
 *   serviceName: 'my-service',
 *   serviceVersion: '1.0.0'
 * })
 *
 * // NOW import the rest of your application
 * import express from 'express'
 * import { createLogger } from '@nirvana-tools/otel-logger'
 * // ...rest of application
 * ```
 */
export function initializeOpenTelemetry(
  config?: OpenTelemetryConfig,
): NodeSDK {
  const serviceName =
    config?.serviceName ||
    process.env.K_SERVICE ||
    process.env.CLOUD_RUN_JOB ||
    "unknown"

  const serviceVersion =
    config?.serviceVersion ||
    process.env.K_REVISION ||
    process.env.JOB_VERSION ||
    "unknown"

  // Import instrumentations dynamically to avoid issues if peer deps not installed
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")
  const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express")
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      ...config?.resourceAttributes,
    }),
    instrumentations: [
      // HTTP instrumentation (required for trace propagation)
      new HttpInstrumentation(),
      // Express instrumentation (creates spans for routes)
      new ExpressInstrumentation(),
      // Winston instrumentation (injects trace_id/span_id into logs)
      new WinstonInstrumentation(),
      // Additional user-provided instrumentations
      ...(config?.instrumentations || []),
    ],
  })

  sdk.start()

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("OpenTelemetry SDK shut down"))
      .catch((error) => console.error("Error shutting down OpenTelemetry SDK", error))
  })

  return sdk
}
