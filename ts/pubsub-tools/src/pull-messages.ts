import { v1 } from "@google-cloud/pubsub"
import { Result, Ok, Err } from "ts-results"
import { PullMessagesParams, PulledMessage } from "./types"

const DEFAULT_MAX_MESSAGES = 10

/**
 * Pull messages from a Google Cloud Pub/Sub subscription.
 * Messages are automatically acknowledged after being pulled.
 *
 * @param params - Pull parameters
 * @returns Result containing array of pulled messages or an error
 */
export async function pullMessages(params: PullMessagesParams): Promise<Result<PulledMessage[], Error>> {
  const { subscriptionName, maxMessages = DEFAULT_MAX_MESSAGES } = params

  const subscriberClient = new v1.SubscriberClient()

  try {
    const [response] = await subscriberClient.pull({
      subscription: subscriptionName,
      maxMessages,
    })

    const receivedMessages = response.receivedMessages ?? []

    if (receivedMessages.length === 0) {
      return Ok([])
    }

    const messages: PulledMessage[] = receivedMessages.map((msg) => ({
      id: msg.ackId ?? "",
      data: msg.message?.data ? Buffer.from(msg.message.data) : Buffer.from(""),
      attributes: (msg.message?.attributes as Record<string, string>) ?? {},
      publishTime: msg.message?.publishTime
        ? new Date(
            Number(msg.message.publishTime.seconds) * 1000 +
              Number(msg.message.publishTime.nanos) / 1000000
          )
        : new Date(),
    }))

    const ackIds = receivedMessages
      .map((msg) => msg.ackId)
      .filter((id): id is string => id !== undefined && id !== null)

    if (ackIds.length > 0) {
      await subscriberClient.acknowledge({
        subscription: subscriptionName,
        ackIds,
      })
    }

    return Ok(messages)
  } catch (error) {
    return Err(error instanceof Error ? error : new Error(String(error)))
  } finally {
    await subscriberClient.close()
  }
}
