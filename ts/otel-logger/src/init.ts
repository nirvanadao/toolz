import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"
import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

export interface InitConfig {
  version: string
  level?: "silly" | "debug" | "verbose" | "info" | "warn" | "error"
  labels?: Record<string, string>
  instrumentations?: any[]
}

let sdk: NodeSDK | null = null
let logger: winston.Logger | null = null

/**
 * Initialize OpenTelemetry + Winston logger.
 *
 * Auto-detects service vs job from Cloud Run env vars:
 * - K_SERVICE present → Service (HTTP + Express + Winston)
 * - CLOUD_RUN_JOB present → Job (Winston only)
 */
export function init(config: InitConfig): winston.Logger {
  if (logger) {
    return logger
  }

  const {
    version,
    level = "info",
    labels = {},
    instrumentations = []
  } = config

  // Auto-detect workload type and name
  const serviceName = process.env.K_SERVICE
  const jobName = process.env.CLOUD_RUN_JOB

  if (!serviceName && !jobName) {
    throw new Error(
      "Could not detect Cloud Run workload type. " +
      "This library requires K_SERVICE or CLOUD_RUN_JOB environment variables. " +
      "For local development, set one of these manually. " +
      "In Cloud Run, these are set automatically."
    )
  }

  if (serviceName && jobName) {
    throw new Error("Both K_SERVICE and CLOUD_RUN_JOB are set. This should not happen.")
  }

  if (serviceName) {
    initService(serviceName, version, level, labels, instrumentations)
  } else {
    initJob(jobName!, version, level, labels, instrumentations)
  }

  return logger!
}

function initService(
  serviceName: string,
  serviceVersion: string,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  instrumentations: any[],
) {
  const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http")
  const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express")
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    }),
    traceExporter: new TraceExporter(),
    instrumentations: [
      new WinstonInstrumentation(),
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
      ...instrumentations,
    ],
  })

  sdk.start()

  logger = createWinstonLogger(serviceName, serviceVersion, level, labels)

  process.on("SIGTERM", shutdown)
}

function initJob(
  jobName: string,
  jobVersion: string,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  instrumentations: any[],
) {
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

  // Read Cloud Run Jobs env vars (optional for local dev)
  const executionId = process.env.CLOUD_RUN_EXECUTION || "unknown-execution"
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX || "0"
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT || "0"
  const taskAttempt = process.env.CLOUD_RUN_TASK_ATTEMPT || "0"

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: jobName,
      [ATTR_SERVICE_VERSION]: jobVersion,
    }),
    traceExporter: new TraceExporter(),
    instrumentations: [new WinstonInstrumentation(), ...instrumentations],
  })

  sdk.start()

  logger = createWinstonLogger(
    jobName,
    jobVersion,
    level,
    {
      job: jobName,
      execution: executionId,
      task: taskIndex,
      ...labels,
    },
    {
      taskAttempt: parseInt(taskAttempt, 10),
      taskCount: parseInt(taskCount, 10),
    },
  )

  process.on("SIGTERM", shutdown)
}

function createWinstonLogger(
  serviceName: string,
  serviceVersion: string,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  defaultMeta?: Record<string, unknown>,
): winston.Logger {
  const isLocalDev = process.env.NODE_ENV === "development"

  const transports: winston.transport[] = []

  if (isLocalDev) {
    transports.push(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp(),
          winston.format.printf(({ level, message, timestamp, ...meta }) => {
            const metaStr = Object.keys(meta).length ? "\n" + JSON.stringify(meta, null, 2) : ""
            return `${timestamp} ${level}: ${message}${metaStr}`
          }),
        ),
      }),
    )
  } else {
    transports.push(
      new LoggingWinston({
        serviceContext: {
          service: serviceName,
          version: serviceVersion,
        },
        labels,
        redirectToStdout: true,
      }),
    )
  }

  return winston.createLogger({
    level,
    defaultMeta: {
      service: serviceName,
      version: serviceVersion,
      ...defaultMeta,
    },
    transports,
  })
}

function shutdown() {
  sdk
    ?.shutdown()
    .then(() => logger?.info("OpenTelemetry SDK shut down"))
    .catch((error) => logger?.error("Error shutting down OpenTelemetry SDK", { error }))
}

export function getLogger(): winston.Logger {
  if (!logger) {
    throw new Error("Logger not initialized. Call init() first.")
  }
  return logger
}
