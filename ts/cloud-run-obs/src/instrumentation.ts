import { credentials } from "@grpc/grpc-js"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express"
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg"
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino"
import { gcpDetector } from "@opentelemetry/resource-detector-gcp"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { NodeSDK } from "@opentelemetry/sdk-node"
import { GoogleAuth } from "google-auth-library"

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
})

const exporter = new OTLPTraceExporter({
  url: "https://telemetry.googleapis.com",
  credentials: credentials.combineChannelCredentials(
    credentials.createSsl(),
    credentials.createFromGoogleCredential(auth),
  ),
})

export type InstrumentationConfig = {
  googleCloudProjectId: string
}

// for future reference with Cloud Run Jobs
// https://github.com/GoogleCloudPlatform/opentelemetry-operations-java/blob/main/detectors/resources-support/src/main/java/com/google/cloud/opentelemetry/detection/GoogleCloudRunJob.java#L21
export function initInstrumentation(config: InstrumentationConfig) {
  const sdk = new NodeSDK({
    traceExporter: exporter,
    resourceDetectors: [gcpDetector],
    resource: resourceFromAttributes({
      "gcp.project_id": config.googleCloudProjectId,
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      new PinoInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  })

  sdk.start()

  process.on("SIGTERM", () => {
    sdk
      .shutdown()
      .then(() => console.log("[Observability] Tracing terminated"))
      .catch((error) => console.log("[Observability] Error terminating tracing", error))
      .finally(() => process.exit(0))
  })
}
