/**
 * Drop-in example for Cloud Run Job.
 * Just 1 file needed!
 */

// FIRST LINE!
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // Auto-discovers CLOUD_RUN_JOB, CLOUD_RUN_EXECUTION, etc.

async function runJob() {
  logger.info('Job started', {
    taskIndex: process.env.CLOUD_RUN_TASK_INDEX,
    taskCount: process.env.CLOUD_RUN_TASK_COUNT,
  })

  try {
    await processData()
    logger.info('Job completed successfully')
  } catch (error) {
    logger.error('Job failed', { error })
    throw error
  }
}

async function processData() {
  // All logs automatically include synthetic trace context
  logger.info('Processing batch', { batchSize: 1000 })
  
  // Do work...
  
  logger.info('Batch processed')
}

runJob()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Job failed:', error)
    process.exit(1)
  })
