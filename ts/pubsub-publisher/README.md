# @nvana-dharma/pubsub-publisher

A production-grade TypeScript library for publishing messages to Google Cloud Pub/Sub with automatic batching for high throughput and cost-effectiveness.

## Features

- **High Performance**: Built-in automatic message batching for optimal throughput
- **Type-safe**: Full TypeScript support with comprehensive type definitions
- **Production Ready**: Graceful shutdown handling ensures no message loss
- **Configurable**: Customizable batching parameters (messages, time, bytes)
- **Statistics**: Built-in tracking of published, failed, and processed messages
- **Simple API**: Easy-to-use interface with minimal configuration

## Installation

```bash
npm install @nvana-dharma/pubsub-publisher
```

or

```bash
pnpm add @nvana-dharma/pubsub-publisher
```

## Usage

### Basic Example

```typescript
import { PubSubPublisher } from "@nvana-dharma/pubsub-publisher"

// Create a publisher instance
const publisher = new PubSubPublisher({
  projectId: "your-gcp-project-id",
  topicName: "your-topic-name",
})

// Publish a message
const message = { userId: "123", action: "login" }
const dataBuffer = Buffer.from(JSON.stringify(message))

try {
  const messageId = await publisher.publish(dataBuffer)
  console.log(`Message published with ID: ${messageId}`)
} catch (error) {
  console.error("Failed to publish message:", error)
}

// Gracefully shutdown when done
await publisher.stop()
```

### Advanced Example with Custom Batching

```typescript
import { PubSubPublisher } from "@nvana-dharma/pubsub-publisher"

const publisher = new PubSubPublisher({
  projectId: process.env.GCP_PROJECT_ID!,
  topicName: "events",
  // Customize batching behavior
  maxMessages: 500,           // Batch up to 500 messages
  maxMilliseconds: 500,       // Or flush after 500ms
  maxBytes: 1024 * 1024 * 10, // Or when batch reaches 10MB
})

// Publish multiple messages
const events = [
  { type: "user_created", userId: "user1" },
  { type: "order_placed", orderId: "order1" },
  { type: "payment_completed", paymentId: "pay1" },
]

for (const event of events) {
  const buffer = Buffer.from(JSON.stringify(event))
  await publisher.publish(buffer)
}

// Get statistics
const stats = publisher.getStats()
console.log(`Processed: ${stats.processed}`)
console.log(`Published: ${stats.published}`)
console.log(`Failed: ${stats.failed}`)

// Cleanup
await publisher.stop()
```

### Production Example with Error Handling

```typescript
import { PubSubPublisher } from "@nvana-dharma/pubsub-publisher"

class MessageService {
  private publisher: PubSubPublisher

  constructor() {
    this.publisher = new PubSubPublisher({
      projectId: process.env.GCP_PROJECT_ID!,
      topicName: process.env.PUBSUB_TOPIC!,
      maxMessages: 100,
      maxMilliseconds: 1000,
      maxBytes: 1024 * 1024 * 5,
    })

    // Handle graceful shutdown
    process.on("SIGTERM", () => this.shutdown())
    process.on("SIGINT", () => this.shutdown())
  }

  async publishEvent(eventType: string, data: any): Promise<string> {
    const message = {
      type: eventType,
      timestamp: Date.now(),
      data,
    }

    const buffer = Buffer.from(JSON.stringify(message))

    try {
      const messageId = await this.publisher.publish(buffer)
      console.log(`Event ${eventType} published: ${messageId}`)
      return messageId
    } catch (error) {
      console.error(`Failed to publish ${eventType}:`, error)
      // Implement retry logic or dead letter queue here
      throw error
    }
  }

  async shutdown(): Promise<void> {
    console.log("Shutting down message service...")
    await this.publisher.stop()
    console.log("Message service shutdown complete")
    process.exit(0)
  }

  getStats() {
    return this.publisher.getStats()
  }
}

// Usage
const service = new MessageService()

await service.publishEvent("user_login", { userId: "123" })
await service.publishEvent("page_view", { page: "/home", userId: "123" })

// Check stats
console.log("Stats:", service.getStats())
```

## API Reference

### `PubSubPublisher`

The main publisher class for sending messages to Google Cloud Pub/Sub.

#### Constructor Options

```typescript
interface PubSubPublisherArgs {
  projectId: string
  topicName: string
  maxMessages?: number      // Default: 100
  maxMilliseconds?: number  // Default: 1000
  maxBytes?: number         // Default: 5242880 (5MB)
}
```

- **projectId** (required): Your Google Cloud project ID
- **topicName** (required): The Pub/Sub topic name to publish to
- **maxMessages**: Maximum number of messages to batch before publishing
- **maxMilliseconds**: Maximum time in milliseconds to wait before publishing a batch
- **maxBytes**: Maximum total size in bytes of messages in a batch

#### Methods

##### `publish(dataBuffer: Buffer): Promise<string>`

Publishes a message to the topic. The message is automatically batched according to the configured batching settings.

**Parameters:**
- `dataBuffer`: The message payload as a Buffer (you are responsible for serialization)

**Returns:**
- Promise that resolves to the message ID

**Throws:**
- Error if the publisher is shutting down
- Error if publishing fails

##### `stop(): Promise<void>`

Gracefully shuts down the publisher. This method:
1. Prevents new messages from being published
2. Flushes any messages in the current batch
3. Closes the Pub/Sub client connection

**Important:** Always call this method before your application exits to ensure no messages are lost.

##### `getStats(): PublisherStats`

Returns the current publisher statistics.

**Returns:**
```typescript
interface PublisherStats {
  processed: number  // Total messages processed
  published: number  // Total messages successfully published
  failed: number     // Total messages that failed to publish
}
```

## Batching Behavior

The publisher automatically batches messages based on three conditions (whichever occurs first):

1. **Message Count**: When `maxMessages` is reached
2. **Time**: After `maxMilliseconds` has elapsed since the first message in the batch
3. **Size**: When the total size reaches `maxBytes`

This batching significantly improves throughput and reduces costs by minimizing the number of API calls to Pub/Sub.

## Error Handling

- Failed publish attempts increment the `failed` counter in statistics
- Errors are logged to console.error
- Exceptions are thrown to the caller for handling
- During shutdown, the publisher flushes pending messages before closing

## Best Practices

1. **Reuse Publisher Instances**: Create one publisher per topic and reuse it throughout your application
2. **Graceful Shutdown**: Always call `stop()` before exiting to flush pending messages
3. **Error Handling**: Implement retry logic for failed publishes based on your requirements
4. **Monitoring**: Use `getStats()` to monitor publisher health and performance
5. **Buffer Management**: Ensure your message buffers are properly serialized before publishing

## Authentication

This library uses the Google Cloud SDK's default authentication. You can authenticate using:

1. **Service Account Key**: Set `GOOGLE_APPLICATION_CREDENTIALS` environment variable
2. **Application Default Credentials**: For GCP environments (GCE, GKE, Cloud Run)
3. **gcloud CLI**: Use `gcloud auth application-default login` for local development

## Requirements

- Node.js >= 18.0.0
- Google Cloud project with Pub/Sub API enabled
- Appropriate permissions to publish to the specified topic

## License

MIT

## Author

Brendan
