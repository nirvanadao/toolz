# helius-webhook-receiver

Express server for receiving Helius webhook events.

## Usage

```typescript
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
import { HeliusWebhookServer, HeliusWebhookPayload } from "@nirvana-tools/helius-webhook-receiver"

const logger = new CloudRunLogger({ projectId: "my-project" })

const server = new HeliusWebhookServer({
  port: 8080,
  authToken: process.env.HELIUS_AUTH_TOKEN!,
  logger,
  handler: async (payloads: HeliusWebhookPayload[]) => {
    for (const event of payloads) {
      console.log("Transaction:", event.signature, event.type)
    }
  },
})

await server.start()
```

## Configuration

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `port` | Yes | - | Port to listen on |
| `authToken` | Yes | - | Expected `Authorization` header value |
| `handler` | Yes | - | Async function to process webhook payloads |
| `logger` | Yes | - | CloudRunLogger instance |
| `webhookPath` | No | `/webhook` | Path for webhook endpoint |
| `healthPath` | No | `/health` | Path for health check endpoint |

## Debug Handler

For development, use the built-in debug handler:

```typescript
import { HeliusWebhookServer, createDebugHandler } from "@nirvana-tools/helius-webhook-receiver"

const server = new HeliusWebhookServer({
  port: 8080,
  authToken: process.env.HELIUS_AUTH_TOKEN!,
  logger,
  handler: createDebugHandler(logger),
})
```

## Helius Setup

1. Go to [Helius Dashboard](https://dev.helius.xyz/dashboard/webhooks)
2. Create a webhook pointing to `https://your-server.com/webhook`
3. Set the Authorization header to match your `authToken`

## Graceful Shutdown

```typescript
process.on("SIGTERM", async () => {
  await server.stop()
  process.exit(0)
})
```
