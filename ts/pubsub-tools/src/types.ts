// ============ Parameter Types ============

export interface PullMessagesParams {
  /** Full subscription name (e.g., "projects/my-project/subscriptions/my-sub") */
  subscriptionName: string
  /** Maximum number of messages to pull. Default: 10 */
  maxMessages?: number
}

export interface ReplayDlqMessagesParams {
  /** Full DLQ subscription name (e.g., "projects/my-project/subscriptions/my-dlq-sub") */
  subscriptionName: string
  /** Full topic name to publish replayed messages (e.g., "projects/my-project/topics/my-replay-topic") */
  topicName: string
  /** Maximum number of messages to replay per call. Default: 100 */
  maxMessages?: number
}

export interface ListDlqMessagesParams {
  /** Full subscription name (e.g., "projects/my-project/subscriptions/my-dlq-sub") */
  subscriptionName: string
}

export interface ReplayDlqMessageParams {
  /** Full DLQ subscription name (e.g., "projects/my-project/subscriptions/my-dlq-sub") */
  subscriptionName: string
  /** Full topic name to publish the replayed message (e.g., "projects/my-project/topics/my-replay-topic") */
  topicName: string
  /** The message ID to replay (from listDlqMessages) */
  messageId: string
}

export interface AckDlqMessageParams {
  /** Full DLQ subscription name (e.g., "projects/my-project/subscriptions/my-dlq-sub") */
  subscriptionName: string
  /** The message ID to acknowledge/remove (from listDlqMessages) */
  messageId: string
}

// ============ Result Types ============

export interface PulledMessage {
  /** Message ID */
  id: string
  /** Message data as Buffer */
  data: Buffer
  /** Message attributes */
  attributes: Record<string, string>
  /** When the message was published */
  publishTime: Date
}

export interface ReplayResult {
  /** Number of messages successfully replayed */
  replayed: number
  /** Number of messages that failed to replay */
  failed: number
  /** Errors encountered during replay */
  errors: Error[]
}

export interface DlqMessage {
  /** Persistent Pub/Sub message ID - use this to identify for replay */
  messageId: string
  /** Message data as Buffer */
  data: Buffer
  /** Message attributes */
  attributes: Record<string, string>
  /** When the message was published */
  publishTime: Date
  /** Number of delivery attempts (if available) */
  deliveryAttempt?: number
}
