import { PubSub } from "@google-cloud/pubsub"
import { IMessageSink } from "./reconn-ws"

export class PubSubPublisher implements IMessageSink {
  private pubsub: PubSub
  private topicName: string

  constructor(projectId: string, topicName: string) {
    this.pubsub = new PubSub({ projectId })
    this.topicName = topicName
  }

  async push(data: string): Promise<void> {
    try {
      // for now, just publish the raw string
      const dataBuffer = Buffer.from(data)
      await this.pubsub.topic(this.topicName).publish(dataBuffer)

      // Optional: Verbose logging for debugging
      // console.log(`📨 Published ID ${messageId}`);
    } catch (error) {
      console.error("🔥 Sink Error (PubSub):", error)
      // We log the error but do not throw, so the websocket stays alive.
    }
  }
}
