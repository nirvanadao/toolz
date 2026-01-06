import { PubSub, Topic } from "@google-cloud/pubsub"
import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"

/**
 * Configuration options for the PubSubPublisher.
 *
 * The batching settings control how messages are grouped before being sent to Pub/Sub.
 * Batching improves throughput and reduces costs by sending multiple messages in a single
 * API request. A batch is sent when ANY of the thresholds (maxMessages, maxMilliseconds,
 * or maxBytes) is reached, whichever comes first.
 */
export type PubSubPublisherArgs = {
  /**
   * Your Google Cloud project ID.
   * @example "my-gcp-project"
   */
  projectId: string

  /**
   * The name of the Pub/Sub topic to publish to.
   * The topic must already exist in your project.
   * @example "my-topic"
   */
  topicName: string

  /**
   * Maximum number of messages to batch together before sending.
   * Lower values reduce latency but increase API calls (and cost).
   * Higher values improve throughput but increase latency.
   * @default 100
   */
  maxMessages?: number

  /**
   * Maximum time in milliseconds to wait before sending a batch.
   * This ensures messages are sent even if maxMessages hasn't been reached.
   * Lower values reduce latency; higher values allow more batching.
   * @default 1000 (1 second)
   */
  maxMilliseconds?: number

  /**
   * Maximum total size in bytes of messages to batch before sending.
   * Pub/Sub has a 10MB limit per publish request.
   * @default 5242880 (5MB)
   */
  maxBytes?: number

  /**
   * Logger instance for structured logging.
   * Use `logger.withLabels({ component: "pubsub-publisher" })` for filtered logs.
   */
  logger: CloudRunLogger
}

export type PublisherStats = {
  /** Total number of messages processed */
  processed: number
  /** Total number of messages published */
  published: number
  /** Total number of messages failed to publish */
  failed: number
}

/**
 * A production-grade Pub/Sub publisher that uses the client library's
 * built-in batching for high throughput and cost-effectiveness.
 */
export class PubSubPublisher {
  private pubSubClient: PubSub
  private topic: Topic
  private logger: CloudRunLogger
  private stats: PublisherStats = {
    processed: 0,
    published: 0,
    failed: 0,
  }
  private isShuttingDown = false

  /**
   * Creates an instance of the PubSubPublisher.
   * @param projectId Your Google Cloud project ID.
   * @param topicName The name of the Pub/Sub topic to publish to.
   * @param batchingOptions Optional settings to configure the client's batching mechanism.
   */
  constructor({
    projectId,
    topicName,
    maxMessages = 100,
    maxMilliseconds = 1000,
    maxBytes = 1024 * 1024 * 5,
    logger,
  }: PubSubPublisherArgs) {
    if (!projectId || !topicName) {
      throw new Error("Project ID and Topic Name are required.")
    }

    this.logger = logger
    this.pubSubClient = new PubSub({ projectId })

    // Configure batching settings for the topic.
    // The client library will automatically batch messages.
    this.topic = this.pubSubClient.topic(topicName, {
      batching: {
        maxMessages,
        maxMilliseconds,
        maxBytes,
      },
    })

    this.logger.info("Publisher initialized", {
      topicName,
      maxMessages,
      maxMilliseconds,
      maxBytes,
    })
  }

  /**
   * Publishes a message to the topic.
   * The actual sending of the message is handled by the client library's batching mechanism.
   * @param dataBuffer The message payload as a Buffer. The caller is responsible for serialization.
   * @returns A promise that resolves with the message ID when the message is accepted for batching.
   */
  public async publish(dataBuffer: Buffer): Promise<string> {
    if (this.isShuttingDown) {
      throw new Error("Publisher is shutting down. Cannot publish new messages.")
    }

    this.stats.processed++
    try {
      // The publish method is asynchronous and returns a message ID promise.
      // The client library handles the actual sending in the background.
      const messageId = await this.topic.publishMessage({ data: dataBuffer })
      this.stats.published++
      return messageId
    } catch (error) {
      this.logger.error("Error publishing message", {
        error: error instanceof Error ? error.message : String(error),
      })
      this.stats.failed++
      throw error
    }
  }

  /**
   * Gracefully shuts down the publisher. It's crucial to call this to ensure
   * that any messages currently in the batch buffer are sent before the process exits.
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return
    }
    this.isShuttingDown = true
    this.logger.info("Shutting down publisher")

    try {
      this.logger.debug("Flushing pending messages")
      await this.topic.flush()
      this.logger.info("All messages flushed")
    } catch (error) {
      this.logger.error("Error flushing messages during shutdown", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    try {
      await this.pubSubClient.close()
      this.logger.info("Publisher shut down successfully")
    } catch (error) {
      this.logger.error("Error closing Pub/Sub client", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Returns a snapshot of the current publishing statistics.
   * The returned object is a copy; modifications won't affect internal state.
   */
  public getStats(): PublisherStats {
    return { ...this.stats }
  }
}
