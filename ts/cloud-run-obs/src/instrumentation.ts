import { NodeSDK } from "@opentelemetry/sdk-node"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"
import { gcpDetector } from "@opentelemetry/resource-detector-gcp"
import { Resource } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base"

/**
 * ============================================================================
 * OPENTELEMETRY SETUP FOR CLOUD RUN (SHARED LIBRARY)
 * ============================================================================
 * USAGE IN CONSUMING APP:
 * 1. Create src/instrumentation.ts
 * 2. import { initInstrumentation } from '@your-org/observability/instrumentation';
 * 3. initInstrumentation();
 * 4. Run: node --require ./dist/instrumentation.js dist/app.js
 */

export interface InstrumentationConfig {
  projectId?: string
  /** Override the auto-detected service name */
  serviceName?: string
  /** Override the auto-detected version */
  version?: string
  /** Sampling ratio (0.0 to 1.0). Defaults to env TRACE_SAMPLING_RATIO or 0.1 */
  samplingRatio?: number
  /** * Wholly replace the default auto-instrumentations.
   * Pass an empty array [] to disable all instrumentation.
   * If undefined, uses the default getNodeAutoInstrumentations() with Cloud Run optimizations.
   */
  instrumentations?: any[]
}

export const initInstrumentation = (config: InstrumentationConfig = {}) => {
  // 1. Configuration Setup
  const projectId = config.projectId || process.env.GOOGLE_CLOUD_PROJECT
  const envSampling = process.env.TRACE_SAMPLING_RATIO ? parseFloat(process.env.TRACE_SAMPLING_RATIO) : 0.1
  const finalRatio = config.samplingRatio ?? envSampling

  if (!projectId) {
    console.warn("[Observability] GOOGLE_CLOUD_PROJECT not set. Traces will not be exported.")
  }

  // 2. Resolve Service Identity
  const serviceName = config.serviceName || process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || "unknown_service"

  const serviceVersion =
    config.version ||
    process.env.APP_VERSION ||
    process.env.K_REVISION ||
    process.env.CLOUD_RUN_EXECUTION ||
    "unknown-version"

  const sdk = new NodeSDK({
    // Export traces to Google Cloud Trace
    traceExporter: new TraceExporter(),

    // Detects Cloud Run environment (sets region, etc.)
    resourceDetectors: [gcpDetector],

    // Apply Manual Overrides
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),

    // Auto-instrumentation
    // If user provides instrumentations, use them. Otherwise, use default defaults.
    instrumentations: config.instrumentations ?? [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-http": {},
        "@opentelemetry/instrumentation-express": {},
        // Reduce noise
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],

    // Sampling Configuration
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(finalRatio),
    }),
  })

  // 3. Start the SDK
  sdk.start()

  console.log(`[Observability] Instrumentation started for ${serviceName} v${serviceVersion}`)

  // 4. Handle Shutdown
  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("[Observability] Tracing terminated"))
      .catch((error) => console.log("[Observability] Error terminating tracing", error))
      .finally(() => process.exit(0))
  })
}
