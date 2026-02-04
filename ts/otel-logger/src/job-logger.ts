import winston from "winston"
import { createLogger, LoggerConfig } from "./logger"

/**
 * Configuration for Cloud Run Job logger.
 *
 * All job metadata is read from Cloud Run environment variables (guaranteed to be set).
 */
export interface JobLoggerConfig extends Omit<LoggerConfig, "serviceName"> {}

/**
 * Creates a Winston logger configured for Cloud Run Jobs.
 *
 * Adds job-specific labels for filtering logs in Cloud Logging:
 * - labels.job: Job name
 * - labels.execution: Execution ID (unique per cron run)
 * - labels.task: Task index (for parallel tasks)
 *
 * Filter logs by labels.execution to see all tasks in a job run.
 * Filter by labels.task to see a specific task.
 *
 * Recommended: Use initJob() instead of calling this directly. initJob() initializes
 * OpenTelemetry + creates the job logger in one call.
 *
 * Environment variables used (automatically set by Cloud Run):
 * - CLOUD_RUN_JOB: Job name (required)
 * - CLOUD_RUN_EXECUTION: Unique execution ID (required)
 * - CLOUD_RUN_TASK_INDEX: Task number (required)
 * - CLOUD_RUN_TASK_COUNT: Total number of tasks (required)
 * - CLOUD_RUN_TASK_ATTEMPT: Retry attempt number (required)
 * - JOB_VERSION: Job version (required)
 *
 * @example
 * ```ts
 * // job.ts
 * import { initializeOpenTelemetry, createJobLogger } from '@nirvana-tools/otel-logger'
 *
 * // Initialize OpenTelemetry FIRST (job mode - Winston only, no HTTP)
 * initializeOpenTelemetry({ workloadType: 'job' })
 *
 * // Create job logger
 * const logger = createJobLogger()
 *
 * // Use anywhere in your job
 * logger.info('Processing batch', { batchSize: 1000 })
 *
 * // Filter in Cloud Logging:
 * // labels.execution="job-execution-12345"  // All tasks in this execution
 * // labels.task="0"                         // Just task 0
 * ```
 *
 * @example
 * ```ts
 * // Simpler: Use initJob() instead
 * import { initJob } from '@nirvana-tools/otel-logger'
 * const logger = initJob()  // Does everything above in one call
 * ```
 */
export function createJobLogger(config?: JobLoggerConfig): winston.Logger {
  // Read guaranteed Cloud Run job environment variables
  const jobName = process.env.CLOUD_RUN_JOB
  const executionId = process.env.CLOUD_RUN_EXECUTION
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT
  const taskAttempt = process.env.CLOUD_RUN_TASK_ATTEMPT

  // Validate all required env vars are set
  if (!jobName) {
    throw new Error(
      "CLOUD_RUN_JOB environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }
  if (!executionId) {
    throw new Error(
      "CLOUD_RUN_EXECUTION environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }
  if (!taskIndex) {
    throw new Error(
      "CLOUD_RUN_TASK_INDEX environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }
  if (!taskCount) {
    throw new Error(
      "CLOUD_RUN_TASK_COUNT environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }
  if (!taskAttempt) {
    throw new Error(
      "CLOUD_RUN_TASK_ATTEMPT environment variable is required (automatically set by Cloud Run). For local testing, set it explicitly.",
    )
  }

  // Create logger with job-specific labels
  // Filter logs by labels.execution to see all tasks in a job run
  // Filter by labels.task to see a specific task
  return createLogger({
    level: config?.level,
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
}
