import { CloudRunLogger, installGlobalErrorHandlers } from "./logger"

/**
 * Configuration options for creating a Cloud Run Job logger.
 */
export type JobLoggerConfig = {
  /**
   * Google Cloud project ID. If not provided, reads from GOOGLE_CLOUD_PROJECT env var.
   */
  projectId?: string

  /**
   * Job name. If not provided, reads from CLOUD_RUN_JOB env var.
   */
  jobName?: string

  /**
   * Job version for Error Reporting. If not provided, reads from JOB_VERSION env var.
   */
  version?: string

  /**
   * Whether to install global error handlers for uncaught exceptions.
   * @default true
   */
  installErrorHandlers?: boolean

  /**
   * Whether to create per-task traces or per-execution traces.
   * - "execution": All parallel tasks share the same trace (default)
   * - "task": Each task gets its own trace
   * @default "execution"
   */
  traceStrategy?: "execution" | "task"

  /**
   * Additional labels to include in all log entries.
   */
  additionalLabels?: Record<string, string>
}

/**
 * Creates a CloudRunLogger instance configured for Cloud Run Jobs.
 *
 * Automatically extracts job metadata from environment variables and sets up:
 * - Service context for Error Reporting
 * - Labels for filtering by job/execution/task
 * - Trace correlation to group logs by execution or task
 * - Global error handlers (optional)
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
 * // Minimal setup
 * const logger = createJobLogger()
 * logger.info("Job started")
 *
 * // With options
 * const logger = createJobLogger({
 *   jobName: "data-processor",
 *   version: "2.1.0",
 *   traceStrategy: "task",
 *   additionalLabels: { environment: "prod" }
 * })
 * ```
 *
 * @example
 * ```ts
 * // In a job with parallel tasks
 * const logger = createJobLogger()
 *
 * // All tasks share the same trace - grouped in Cloud Logging
 * logger.info("Processing batch", {
 *   taskIndex: parseInt(process.env.CLOUD_RUN_TASK_INDEX || "0"),
 *   batchSize: 1000
 * })
 *
 * // Filter in Cloud Logging:
 * // labels.execution="job-execution-12345"  // All tasks
 * // labels.task="0"                         // Just task 0
 * ```
 */
export function createJobLogger(config: JobLoggerConfig = {}): CloudRunLogger {
  const {
    projectId = process.env.GOOGLE_CLOUD_PROJECT,
    jobName = process.env.CLOUD_RUN_JOB || "unknown-job",
    version = process.env.JOB_VERSION,
    installErrorHandlers = true,
    traceStrategy = "execution",
    additionalLabels = {},
  } = config

  if (!projectId) {
    throw new Error(
      "projectId is required. Provide it via config or GOOGLE_CLOUD_PROJECT env var",
    )
  }

  // Extract Cloud Run Job environment variables
  const executionId = process.env.CLOUD_RUN_EXECUTION || "unknown-execution"
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX || "0"
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT || "1"
  const taskAttempt = process.env.CLOUD_RUN_TASK_ATTEMPT || "0"

  // Create base logger with job context
  const logger = new CloudRunLogger({
    projectId,
    serviceContext: {
      service: jobName,
      version,
    },
    labels: {
      job: jobName,
      execution: executionId,
      task: taskIndex,
      ...additionalLabels,
    },
    defaultFields: {
      taskAttempt: parseInt(taskAttempt, 10),
      taskCount: parseInt(taskCount, 10),
    },
  })

  // Generate trace ID based on strategy
  let traceId: string
  if (traceStrategy === "task") {
    // Unique trace per task
    traceId = `${executionId}-${taskIndex}`
      .replace(/-/g, "")
      .substring(0, 32)
      .padEnd(32, "0")
  } else {
    // Shared trace for all tasks in execution (default)
    traceId = executionId.replace(/-/g, "").substring(0, 32).padEnd(32, "0")
  }

  // Attach trace context
  const jobLogger = logger.withTrace({
    trace: `projects/${projectId}/traces/${traceId}`,
    spanId: taskIndex,
  })

  // Install global error handlers if requested
  if (installErrorHandlers) {
    installGlobalErrorHandlers(jobLogger)
  }

  return jobLogger
}
