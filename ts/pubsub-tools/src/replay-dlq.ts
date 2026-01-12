import { PubSub, v1 } from "@google-cloud/pubsub"
import { Result, Ok, Err } from "ts-results"
import {
  ReplayDlqMessagesParams,
  ReplayResult,
  ListDlqMessagesParams,
  DlqMessage,
  ReplayDlqMessageParams,
  AckDlqMessageParams,
} from "./types"

const DEFAULT_MAX_MESSAGES = 100
const BATCH_SIZE = 100

/**
 * Replay messages from a DLQ monitoring subscription to a replay topic.
 * Messages are processed one-by-one: pulled, published to replay topic, then acknowledged.
 * If publishing fails, the message is NOT acknowledged so it can be retried.
 *
 * @param params - Replay parameters
 * @returns Result containing replay summary or an error
 */
export async function replayDlqMessages(params: ReplayDlqMessagesParams): Promise<Result<ReplayResult, Error>> {
  const { subscriptionName, topicName, maxMessages = DEFAULT_MAX_MESSAGES } = params

  const subscriberClient = new v1.SubscriberClient()
  const pubsub = new PubSub()
  const topic = pubsub.topic(topicName)

  try {
    const [response] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages,
    })

    const receivedMessages = response.receivedMessages ?? []

    if (receivedMessages.length === 0) {
      return Ok({ replayed: 0, failed: 0, errors: [] })
    }

    let replayed = 0
    let failed = 0
    const errors: Error[] = []

    for (const msg of receivedMessages) {
      try {
        const data = msg.message?.data ? Buffer.from(msg.message.data) : Buffer.from("")
        const attributes = (msg.message?.attributes as Record<string, string>) ?? {}

        await topic.publishMessage({
          data,
          attributes,
        })

        if (msg.ackId) {
          await subscriberClient.acknowledge({
            subscription: subscriptionName,
            ackIds: [msg.ackId],
          })
        }
        replayed++
      } catch (error) {
        failed++
        errors.push(error instanceof Error ? error : new Error(String(error)))
      }
    }

    return Ok({ replayed, failed, errors })
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await subscriberClient.close()
  }
}

/**
 * List all messages in a DLQ subscription without acknowledging them.
 * Messages remain in the queue and will be redelivered after the ack deadline.
 *
 * @param params - List parameters
 * @returns Result containing array of all DLQ messages or an error
 */
export async function listDlqMessages(params: ListDlqMessagesParams): Promise<Result<DlqMessage[], Error>> {
  const { subscriptionName } = params

  const subscriberClient = new v1.SubscriberClient()

  try {
    const allMessages: DlqMessage[] = []

    while (true) {
      const [response] = await subscriberClient.pull({
        subscription: subscriptionName,
        maxMessages: BATCH_SIZE,
      })

      const receivedMessages = response.receivedMessages ?? []

      if (receivedMessages.length === 0) {
        break
      }

      for (const msg of receivedMessages) {
        allMessages.push({
          messageId: msg.message?.messageId ?? "",
          data: msg.message?.data ? Buffer.from(msg.message.data) : Buffer.from(""),
          attributes: (msg.message?.attributes as Record<string, string>) ?? {},
          publishTime: msg.message?.publishTime
            ? new Date(
                Number(msg.message.publishTime.seconds) * 1000 +
                  Number(msg.message.publishTime.nanos) / 1000000
              )
            : new Date(),
          deliveryAttempt: msg.deliveryAttempt ?? undefined,
        })
      }

      if (receivedMessages.length < BATCH_SIZE) {
        break
      }
    }

    return Ok(allMessages)
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await subscriberClient.close()
  }
}

/**
 * Replay a single message from a DLQ subscription by its message ID.
 * Pulls messages, finds the one with matching ID, publishes it to the replay topic,
 * and acknowledges only that message.
 *
 * @param params - Replay parameters
 * @returns Result containing true if found and replayed, false if not found
 */
export async function replayDlqMessage(params: ReplayDlqMessageParams): Promise<Result<boolean, Error>> {
  const { subscriptionName, topicName, messageId } = params

  const subscriberClient = new v1.SubscriberClient()
  const pubsub = new PubSub()
  const topic = pubsub.topic(topicName)

  try {
    while (true) {
      const [response] = await subscriberClient.pull({
        subscription: subscriptionName,
        maxMessages: BATCH_SIZE,
      })

      const receivedMessages = response.receivedMessages ?? []

      if (receivedMessages.length === 0) {
        return Ok(false)
      }

      for (const msg of receivedMessages) {
        if (msg.message?.messageId === messageId) {
          const data = msg.message?.data ? Buffer.from(msg.message.data) : Buffer.from("")
          const attributes = (msg.message?.attributes as Record<string, string>) ?? {}

          await topic.publishMessage({
            data,
            attributes,
          })

          if (msg.ackId) {
            await subscriberClient.acknowledge({
              subscription: subscriptionName,
              ackIds: [msg.ackId],
            })
          }

          return Ok(true)
        }
      }

      if (receivedMessages.length < BATCH_SIZE) {
        return Ok(false)
      }
    }
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await subscriberClient.close()
  }
}

/**
 * Acknowledge (remove) a message from the DLQ without replaying it.
 * Use this to discard messages you don't want to replay.
 *
 * @param params - Ack parameters
 * @returns Result containing true if found and acknowledged, false if not found
 */
export async function ackDlqMessage(params: AckDlqMessageParams): Promise<Result<boolean, Error>> {
  const { subscriptionName, messageId } = params

  const subscriberClient = new v1.SubscriberClient()

  try {
    while (true) {
      const [response] = await subscriberClient.pull({
        subscription: subscriptionName,
        maxMessages: BATCH_SIZE,
      })

      const receivedMessages = response.receivedMessages ?? []

      if (receivedMessages.length === 0) {
        return Ok(false)
      }

      for (const msg of receivedMessages) {
        if (msg.message?.messageId === messageId) {
          if (msg.ackId) {
            await subscriberClient.acknowledge({
              subscription: subscriptionName,
              ackIds: [msg.ackId],
            })
          }

          return Ok(true)
        }
      }

      if (receivedMessages.length < BATCH_SIZE) {
        return Ok(false)
      }
    }
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await subscriberClient.close()
  }
}
