import { createGcpLoggingPinoConfig } from "@google-cloud/pino-logging-gcp-config"
import pino from "pino"
export type { pino } from "pino"

const service = process.env.K_SERVICE || process.env.CLOUD_RUN_JOB || "unknown-service"
const version = process.env.K_REVISION || process.env.CLOUD_RUN_EXECUTION || "unknown-version"
const level = process.env.LOG_LEVEL || "debug"

export const logger = pino(
  createGcpLoggingPinoConfig(
    {
      serviceContext: {
        service,
        version,
      },
    },
    { level },
  ),
)
