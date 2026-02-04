import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"
import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

let initialized = false
let sdk: NodeSDK | null = null
let logger: winston.Logger | null = null

/**
 * Initialize for Cloud Run service.
 */
export function initService(
  serviceName: string,
  serviceVersion: string,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  instrumentations: any[],
): winston.Logger {
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Initialize OpenTelemetry for services (HTTP + Express + Winston)
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

  initialized = true
  return logger
}

/**
 * Initialize for Cloud Run job.
 */
export function initJob(
  jobName: string,
  jobVersion: string,
  executionId: string,
  taskIndex: string,
  taskCount: number,
  taskAttempt: number,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  instrumentations: any[],
): winston.Logger {
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Initialize OpenTelemetry for jobs (Winston only, no HTTP)
  const { WinstonInstrumentation } = require("@opentelemetry/instrumentation-winston")

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
      taskAttempt,
      taskCount,
    },
  )

  process.on("SIGTERM", shutdown)

  initialized = true
  return logger
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
            const metaStr = Object.keys(meta).length
              ? "\n" + JSON.stringify(meta, null, 2)
              : ""
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
    throw new Error("Logger not initialized. Call initService() or initJob() first.")
  }
  return logger
}
