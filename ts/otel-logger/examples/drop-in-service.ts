/**
 * Drop-in example for Cloud Run Service.
 * Just 2 files needed: index.ts and this file!
 */

// index.ts - FIRST LINE!
import { init } from '@nirvana-tools/otel-logger'
const logger = init()  // That's it! Auto-discovers everything from Cloud Run env vars

// Now import the rest
import express from 'express'

const app = express()
app.use(express.json())

app.get('/healthz', (req, res) => {
  res.status(200).send('OK')
})

app.get('/api/users', async (req, res) => {
  // All logs automatically include trace context!
  logger.info('Fetching users', { query: req.query })
  
  try {
    const users = await fetchUsers()
    res.json({ users })
  } catch (error) {
    logger.error('Failed to fetch users', { error })
    res.status(500).json({ error: 'Internal server error' })
  }
})

async function fetchUsers() {
  // Even nested functions automatically include trace context!
  logger.info('Querying database')
  return []
}

const PORT = parseInt(process.env.PORT || '8080', 10)
app.listen(PORT, () => {
  logger.info('Service started', { port: PORT })
})
