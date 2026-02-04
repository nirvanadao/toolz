/**
 * Cloud Run Job with automatic trace correlation
 */
import { createJobLogger } from '@nirvana-tools/otel-logger'

const logger = createJobLogger({
  traceStrategy: 'execution', // All parallel tasks share same trace
})

export async function runJob() {
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
