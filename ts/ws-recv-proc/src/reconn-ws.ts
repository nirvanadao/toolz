import WebSocket from "ws"
import { IMonitoredService } from "./harness"

export interface SocketConfig {
  url: string
  subscriptionMessage: any // The payload to send on 'open'
  backoffInitial?: number
  backoffMax?: number
}

/**
 * Represents a destination for data.
 * Can be PubSub, a Logger, a Database, etc.
 */
export interface IMessageSink {
  push(data: string): Promise<void>
}

export class ReconnectingSubscriptionSocket implements IMonitoredService {
  private ws: WebSocket | null = null
  private config: SocketConfig
  private sink: IMessageSink

  // State
  private ready: boolean = false
  private shuttingDown: boolean = false
  private retryCount: number = 0

  constructor(config: SocketConfig, sink: IMessageSink) {
    this.config = config
    this.sink = sink

    // Bindings
    this.connect = this.connect.bind(this)
    this.handleOpen = this.handleOpen.bind(this)
    this.handleMessage = this.handleMessage.bind(this)
    this.handleClose = this.handleClose.bind(this)
    this.handleError = this.handleError.bind(this)
  }

  public start() {
    console.log("🚀 Starting WebSocket Service...")
    this.connect()
  }

  public isReady(): boolean {
    return this.ready
  }

  private connect() {
    if (this.shuttingDown) return

    console.log(`🔌 Connecting to ${this.config.url}...`)
    try {
      this.ws = new WebSocket(this.config.url)
      this.ws.on("open", this.handleOpen)
      this.ws.on("message", this.handleMessage)
      this.ws.on("close", this.handleClose)
      this.ws.on("error", this.handleError)
    } catch (e) {
      this.handleClose() // Trigger backoff
    }
  }

  private handleOpen() {
    console.log("✅ Connected. Sending Subscription...")
    this.ready = true
    this.retryCount = 0

    // Send the "boot-up" message to subscribe
    const payload =
      typeof this.config.subscriptionMessage === "string"
        ? this.config.subscriptionMessage
        : JSON.stringify(this.config.subscriptionMessage)

    this.ws?.send(payload, (err) => {
      if (err) console.error("❌ Failed to send subscription:", err)
      else console.log("📤 Subscription sent.")
    })
  }

  private async handleMessage(data: WebSocket.RawData) {
    const asString = data.toString()
    // Here you could add parsing logic if you only want specific fields
    await this.sink.push(asString)
  }

  private handleClose() {
    this.ready = false
    if (this.shuttingDown) return

    const initial = this.config.backoffInitial || 1000
    const max = this.config.backoffMax || 60000

    // Exponential backoff
    const delay = Math.min(initial * Math.pow(2, this.retryCount), max)

    console.warn(`⚠️ Connection lost. Retrying in ${delay}ms...`)
    this.retryCount++

    setTimeout(this.connect, delay)
  }

  private handleError(err: Error) {
    console.error("❗ WebSocket Error:", err.message)
    // 'close' will trigger automatically after error, so we rely on handleClose for retry logic
  }

  public shutdown() {
    this.shuttingDown = true
    this.ready = false
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
    }
  }
}
