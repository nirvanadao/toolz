export interface WebSocketClientOptions {
  /** Called when a message is received on a subscribed channel */
  onMessage: (channel: string, data: string) => void
  /** Called when an error message is received (e.g., invalid channel) */
  onError?: (error: string, channel?: string) => void
  /** Called when connection is established */
  onConnect?: () => void
  /** Called when connection is lost */
  onDisconnect?: () => void
  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean
  /** Initial reconnect delay in ms (default: 1000). Doubles on each attempt. */
  reconnectDelay?: number
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number
}

/**
 * WebSocket client for subscribing to channels and receiving push notifications.
 *
 * @example
 * ```typescript
 * const client = new WebSocketClient("ws://localhost:3000/ws", {
 *   onMessage: (channel, data) => {
 *     console.log(`${channel}: ${data}`)
 *   },
 * })
 *
 * client.subscribe(["BTC", "ETH"])
 * client.unsubscribe(["ETH"])
 * client.close()
 * ```
 */
export class WebSocketClient {
  private ws: WebSocket | null = null
  private url: string
  private options: WebSocketClientOptions
  private subscriptions = new Set<string>()
  private closed = false
  private currentDelay: number

  constructor(url: string, options: WebSocketClientOptions) {
    this.url = url
    this.options = options
    this.currentDelay = options.reconnectDelay ?? 1000
    this.connect()
  }

  private connect(): void {
    if (this.closed) return

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      // Reset backoff on successful connect
      this.currentDelay = this.options.reconnectDelay ?? 1000
      // Resubscribe to all channels on reconnect
      if (this.subscriptions.size > 0) {
        this.ws?.send(JSON.stringify({ subscribe: Array.from(this.subscriptions) }))
      }
      this.options.onConnect?.()
    }

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.error) {
          this.options.onError?.(msg.error, msg.channel)
        } else if (msg.channel) {
          this.options.onMessage(msg.channel, msg.data)
        }
      } catch {
        // Raw string message, pass through
        this.options.onMessage("", event.data)
      }
    }

    this.ws.onclose = () => {
      this.options.onDisconnect?.()
      if (!this.closed && this.options.reconnect !== false) {
        setTimeout(() => this.connect(), this.currentDelay)
        // Exponential backoff: double delay, cap at max
        const maxDelay = this.options.maxReconnectDelay ?? 30000
        this.currentDelay = Math.min(this.currentDelay * 2, maxDelay)
      }
    }

    this.ws.onerror = () => {
      // Error will trigger onclose, which handles reconnection
    }
  }

  /**
   * Subscribe to one or more channels.
   * @param channels - Channel names to subscribe to
   */
  subscribe(channels: string[]): void {
    for (const ch of channels) {
      this.subscriptions.add(ch)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ subscribe: channels }))
    }
  }

  /**
   * Unsubscribe from one or more channels.
   * @param channels - Channel names to unsubscribe from
   */
  unsubscribe(channels: string[]): void {
    for (const ch of channels) {
      this.subscriptions.delete(ch)
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ unsubscribe: channels }))
    }
  }

  /**
   * Returns the current set of subscribed channels.
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions)
  }

  /**
   * Returns true if connected to the server.
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * Close the connection permanently (no reconnect).
   */
  close(): void {
    this.closed = true
    this.ws?.close()
  }
}
