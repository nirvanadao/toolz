import { NodeSDK } from "@opentelemetry/sdk-node"
import { Resource } from "@opentelemetry/resources"
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions"
import { TraceExporter } from "@google-cloud/opentelemetry-cloud-trace-exporter"
import winston from "winston"
import { LoggingWinston } from "@google-cloud/logging-winston"

export interface InitConfig {
  serviceName: string
  serviceVersion: string
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error"
  labels: Record<string, string>
  instrumentations: any[]
  // For jobs only:
  executionId?: string
  taskIndex?: string
  taskCount?: number
  taskAttempt?: number
}

let initialized = false
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
  if (initialized) {
    if (!logger) {
      throw new Error("Logger was initialized but not available")
    }
    return logger
  }

  // Auto-detect workload type
  const isService = !!process.env.K_SERVICE
  const isJob = !!process.env.CLOUD_RUN_JOB

  if (!isService && !isJob) {
    throw new Error(
      "Could not detect Cloud Run workload type. Set K_SERVICE (for services) or CLOUD_RUN_JOB (for jobs).",
    )
  }

  if (isService && isJob) {
    throw new Error(
      "Both K_SERVICE and CLOUD_RUN_JOB are set. This should not happen.",
    )
  }

  if (isService) {
    initService(
      config.serviceName,
      config.serviceVersion,
      config.level,
      config.labels,
      config.instrumentations,
    )
  } else {
    // Validate job-specific fields
    if (!config.executionId) {
      throw new Error("executionId is required for jobs")
    }
    if (!config.taskIndex) {
      throw new Error("taskIndex is required for jobs")
    }
    if (config.taskCount === undefined) {
      throw new Error("taskCount is required for jobs")
    }
    if (config.taskAttempt === undefined) {
      throw new Error("taskAttempt is required for jobs")
    }

    initJob(
      config.serviceName,
      config.serviceVersion,
      config.executionId,
      config.taskIndex,
      config.taskCount,
      config.taskAttempt,
      config.level,
      config.labels,
      config.instrumentations,
    )
  }

  initialized = true
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
  executionId: string,
  taskIndex: string,
  taskCount: number,
  taskAttempt: number,
  level: "silly" | "debug" | "verbose" | "info" | "warn" | "error",
  labels: Record<string, string>,
  instrumentations: any[],
) {
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
    throw new Error("Logger not initialized. Call init() first.")
  }
  return logger
}
