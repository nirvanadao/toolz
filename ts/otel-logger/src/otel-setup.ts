import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"

/**
 * Workload type determines which instrumentations to load.
 * - "service": HTTP services (Cloud Run services) - includes HTTP + Express + Winston
 * - "job": Batch jobs (Cloud Run jobs) - includes Winston only (no HTTP overhead)
 */
export type WorkloadType = "service" | "job"

/**
 * Configuration for OpenTelemetry initialization.
 *
 * Service name and version are read from Cloud Run environment variables (guaranteed to be set).
 */
export interface OpenTelemetryConfig {
  /**
   * Workload type determines which instrumentations to load.
   * - "service": HTTP services - includes HTTP + Express + Winston instrumentation
   * - "job": Batch jobs - includes Winston only (no HTTP/Express overhead)
   *
   * @default Auto-detected: "service" if K_SERVICE is set, "job" if CLOUD_RUN_JOB is set
   */
  workloadType?: WorkloadType

  /**
   * Additional instrumentations to enable beyond the defaults.
   * Default instrumentations depend on workloadType:
   * - service: HTTP, Express, and Winston
   * - job: Winston only
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
 * For HTTP services (workloadType: "service"):
 * - Automatic HTTP/Express instrumentation for trace propagation
 * - Winston instrumentation for automatic trace correlation in logs
 * - Cloud Trace exporter (when running on GCP)
 *
 * For jobs (workloadType: "job"):
 * - Winston instrumentation only (no HTTP/Express overhead)
 * - Cloud Trace exporter (when running on GCP)
 *
 * @example
 * ```ts
 * // index.ts - FIRST lines of your application
 * import { initializeOpenTelemetry } from '@nirvana-tools/otel-logger'
 *
 * // For HTTP service
 * initializeOpenTelemetry({
 *   serviceName: 'my-service',
 *   workloadType: 'service'
 * })
 *
 * // For job
 * initializeOpenTelemetry({
 *   serviceName: 'my-job',
 *   workloadType: 'job'
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
  // Read guaranteed Cloud Run environment variables
  const serviceName = process.env.K_SERVICE || process.env.CLOUD_RUN_JOB
  const serviceVersion = process.env.K_REVISION || process.env.JOB_VERSION

  if (!serviceName) {
    throw new Error(
      "K_SERVICE or CLOUD_RUN_JOB environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  if (!serviceVersion) {
    throw new Error(
      "K_REVISION or JOB_VERSION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  // Auto-detect workload type if not specified
  const workloadType =
    config?.workloadType ?? (process.env.K_SERVICE ? "service" : "job")

  // Import instrumentations dynamically to avoid issues if peer deps not installed
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  // Build instrumentations list based on workload type
  const instrumentations = [
    // Winston instrumentation (needed by all workloads)
    new WinstonInstrumentation(),
  ]

  // Add HTTP/Express instrumentation only for services
  if (workloadType === "service") {
    const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")
    const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express")
    instrumentations.push(
      // HTTP instrumentation (required for trace propagation)
      new HttpInstrumentation(),
      // Express instrumentation (creates spans for routes)
      new ExpressInstrumentation(),
    )
  }

  // Add user-provided instrumentations
  instrumentations.push(...(config?.instrumentations || []))

  // TraceExporter auto-detects projectId from GCP metadata server
  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      ...config?.resourceAttributes,
    }),
    traceExporter: new TraceExporter(),
    instrumentations,
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
