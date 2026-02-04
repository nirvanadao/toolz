/**
 * Express app with automatic trace correlation
 */
import express from 'express'
import { createExpressMiddleware } from '@nirvana-tools/otel-logger'
import { logger } from './logger'

export const app = express()

app.use(express.json())

// Attach logger middleware - enables req.log with automatic trace correlation
app.use(createExpressMiddleware({ logger }))

app.get('/healthz', (req, res) => {
  res.status(200).send('OK')
})

app.get('/api/users', async (req, res) => {
  // req.log automatically includes trace context!
  req.log.info('Fetching users', { query: req.query })
  
  try {
    const users = await fetchUsers()
    res.json({ users })
  } catch (error) {
    req.log.error('Failed to fetch users', { error })
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function fetchUsers() {
  // Even nested function logs include trace context automatically!
  logger.info('Querying database')
  return []
}
