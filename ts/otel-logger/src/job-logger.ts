import winston from "winston"
import { createLogger, LoggerConfig } from "./logger"

/**
 * Configuration for Cloud Run Job logger.
 */
export interface JobLoggerConfig extends Omit<LoggerConfig, "serviceName"> {
  /**
   * Job name.
   * @default process.env.CLOUD_RUN_JOB || "unknown-job"
   */
  jobName?: string

  /**
   * Trace strategy for parallel tasks.
   * - "execution": All parallel tasks share the same trace (default)
   * - "task": Each task gets its own trace
   * @default "execution"
   */
  traceStrategy?: "execution" | "task"

  /**
   * Whether to install global error handlers.
   * @default true
   */
  installErrorHandlers?: boolean
}

/**
 * Creates a Winston logger configured for Cloud Run Jobs with synthetic trace context.
 *
 * Unlike HTTP services (where OpenTelemetry automatically creates traces), Cloud Run Jobs
 * don't have incoming HTTP requests. This helper creates synthetic traces based on job
 * execution metadata, allowing you to correlate logs by execution or task.
 *
 * Environment variables used:
 * - GOOGLE_CLOUD_PROJECT: GCP project ID
 * - CLOUD_RUN_JOB: Job name
 * - CLOUD_RUN_EXECUTION: Unique execution ID
 * - CLOUD_RUN_TASK_INDEX: Task number (for parallel tasks)
 * - CLOUD_RUN_TASK_COUNT: Total number of tasks
 * - CLOUD_RUN_TASK_ATTEMPT: Retry attempt number
 * - JOB_VERSION: Job version (optional)
 *
 * @example
 * ```ts
 * // job.ts
 * import { initializeOpenTelemetry, createJobLogger } from '@nirvana-tools/otel-logger'
 *
 * // Initialize OpenTelemetry FIRST
 * initializeOpenTelemetry({ serviceName: 'data-processor' })
 *
 * // Create job logger
 * const logger = createJobLogger({
 *   jobName: 'data-processor',
 *   traceStrategy: 'execution' // All tasks share trace
 * })
 *
 * // Use anywhere in your job
 * logger.info('Processing batch', { batchSize: 1000 })
 *
 * // Filter in Cloud Logging:
 * // labels.execution="job-execution-12345"  // All tasks
 * // labels.task="0"                         // Just task 0
 * ```
 */
export function createJobLogger(config?: JobLoggerConfig): winston.Logger {
  const projectId =
    config?.projectId ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID

  if (!projectId) {
    throw new Error(
      "projectId is required. Provide via config or GOOGLE_CLOUD_PROJECT env var",
    )
  }

  const jobName = config?.jobName || process.env.CLOUD_RUN_JOB || "unknown-job"
  const executionId = process.env.CLOUD_RUN_EXECUTION || "unknown-execution"
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX || "0"
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT || "1"
  const taskAttempt = process.env.CLOUD_RUN_TASK_ATTEMPT || "0"
  const traceStrategy = config?.traceStrategy || "execution"
  const installErrorHandlers = config?.installErrorHandlers ?? true

  // Create base logger
  const logger = createLogger({
    ...config,
    serviceName: jobName,
    labels: {
      job: jobName,
      execution: executionId,
      task: taskIndex,
      ...config?.labels,
    },
    defaultMeta: {
      taskAttempt: parseInt(taskAttempt, 10),
      taskCount: parseInt(taskCount, 10),
      ...config?.defaultMeta,
    },
  })

  // Create synthetic trace ID based on strategy
  let traceId: string
  let spanId: string
  if (traceStrategy === "task") {
    // Unique trace per task
    traceId = `${executionId}-${taskIndex}`
      .replace(/-/g, "")
      .substring(0, 32)
      .padEnd(32, "0")
    spanId = taskIndex.padStart(16, "0")
  } else {
    // Shared trace for all tasks in execution (default)
    traceId = executionId.replace(/-/g, "").substring(0, 32).padEnd(32, "0")
    spanId = taskIndex.padStart(16, "0")
  }

  // Create a child logger with synthetic trace context
  // Since there's no HTTP request for jobs, we manually add trace fields
  // that Cloud Logging recognizes for correlation
  const jobLogger = logger.child({
    "logging.googleapis.com/trace": `projects/${projectId}/traces/${traceId}`,
    "logging.googleapis.com/spanId": spanId,
    "logging.googleapis.com/trace_sampled": true,
  })

  // Install global error handlers
  if (installErrorHandlers) {
    process.on("uncaughtException", (error: Error) => {
      jobLogger.error("Uncaught exception", { error })
      setTimeout(() => {
        process.exit(1)
      }, 1000)
    })

    process.on("unhandledRejection", (reason: unknown) => {
      const error =
        reason instanceof Error
          ? reason
          : new Error(`Unhandled rejection: ${String(reason)}`)
      jobLogger.error("Unhandled promise rejection", { error })
    })
  }

  return jobLogger
}
