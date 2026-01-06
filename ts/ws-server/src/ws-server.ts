import { Server as HttpServer } from "http"
import { WebSocketServer as WsServer, WebSocket } from "ws"

export interface SubscriptionCallbacks {
  /** Called when the first client subscribes to a channel. Use this to set up upstream subscriptions (e.g., Redis). */
  onSubscribe: (channel: string) => void | Promise<void>
  /** Called when the last client unsubscribes from a channel. Use this to tear down upstream subscriptions. */
  onUnsubscribe: (channel: string) => void | Promise<void>
}

export interface ClientMessage {
  type: "subscribe" | "unsubscribe"
  channel: string
}

export interface ServerMessage<T = unknown> {
  type: "message" | "error" | "subscribed" | "unsubscribed"
  channel?: string
  data?: T
  error?: string
}

export interface WebSocketServerOptions extends SubscriptionCallbacks {
  /** Path for WebSocket connections (default: "/ws") */
  path?: string
  /** Called when a client connects */
  onConnect?: (clientId: string) => void
  /** Called when a client disconnects */
  onDisconnect?: (clientId: string) => void
  /** Called on client message parsing errors */
  onError?: (clientId: string, error: Error) => void
}

export class WebSocketServer {
  private wss: WsServer
  private clients = new Map<string, WebSocket>()
  private clientSubscriptions = new Map<string, Set<string>>() // clientId -> channels
  private channelSubscribers = new Map<string, Set<string>>() // channel -> clientIds
  private clientIdCounter = 0
  private options: WebSocketServerOptions

  constructor(server: HttpServer, options: WebSocketServerOptions) {
    this.options = options
    this.wss = new WsServer({
      server,
      path: options.path ?? "/ws",
    })

    this.wss.on("connection", (ws) => this.handleConnection(ws))
  }

  private generateClientId(): string {
    return `client_${++this.clientIdCounter}_${Date.now()}`
  }

  private handleConnection(ws: WebSocket): void {
    const clientId = this.generateClientId()
    this.clients.set(clientId, ws)
    this.clientSubscriptions.set(clientId, new Set())

    this.options.onConnect?.(clientId)

    ws.on("message", (data) => this.handleMessage(clientId, data))
    ws.on("close", () => this.handleDisconnect(clientId))
    ws.on("error", (err) => this.options.onError?.(clientId, err))
  }

  private async handleMessage(clientId: string, rawData: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    const ws = this.clients.get(clientId)
    if (!ws) return

    try {
      const message = JSON.parse(rawData.toString()) as ClientMessage

      if (message.type === "subscribe" && message.channel) {
        await this.subscribeClient(clientId, message.channel)
        this.send(clientId, { type: "subscribed", channel: message.channel })
      } else if (message.type === "unsubscribe" && message.channel) {
        await this.unsubscribeClient(clientId, message.channel)
        this.send(clientId, { type: "unsubscribed", channel: message.channel })
      }
    } catch (err) {
      this.options.onError?.(clientId, err instanceof Error ? err : new Error(String(err)))
      this.send(clientId, { type: "error", error: "Invalid message format" })
    }
  }

  private async subscribeClient(clientId: string, channel: string): Promise<void> {
    const clientChannels = this.clientSubscriptions.get(clientId)
    if (!clientChannels || clientChannels.has(channel)) return

    clientChannels.add(channel)

    let subscribers = this.channelSubscribers.get(channel)
    const isFirstSubscriber = !subscribers || subscribers.size === 0

    if (!subscribers) {
      subscribers = new Set()
      this.channelSubscribers.set(channel, subscribers)
    }
    subscribers.add(clientId)

    if (isFirstSubscriber) {
      await this.options.onSubscribe(channel)
    }
  }

  private async unsubscribeClient(clientId: string, channel: string): Promise<void> {
    const clientChannels = this.clientSubscriptions.get(clientId)
    if (!clientChannels || !clientChannels.has(channel)) return

    clientChannels.delete(channel)

    const subscribers = this.channelSubscribers.get(channel)
    if (subscribers) {
      subscribers.delete(clientId)

      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel)
        await this.options.onUnsubscribe(channel)
      }
    }
  }

  private async handleDisconnect(clientId: string): Promise<void> {
    const clientChannels = this.clientSubscriptions.get(clientId)
    if (clientChannels) {
      for (const channel of clientChannels) {
        const subscribers = this.channelSubscribers.get(channel)
        if (subscribers) {
          subscribers.delete(clientId)
          if (subscribers.size === 0) {
            this.channelSubscribers.delete(channel)
            await this.options.onUnsubscribe(channel)
          }
        }
      }
    }

    this.clientSubscriptions.delete(clientId)
    this.clients.delete(clientId)
    this.options.onDisconnect?.(clientId)
  }

  /** Send a message to a specific client */
  send<T>(clientId: string, message: ServerMessage<T>): void {
    const ws = this.clients.get(clientId)
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
    }
  }

  /** Broadcast a message to all clients subscribed to a channel */
  broadcast<T>(channel: string, data: T): void {
    const subscribers = this.channelSubscribers.get(channel)
    if (!subscribers) return

    const message: ServerMessage<T> = { type: "message", channel, data }
    const payload = JSON.stringify(message)

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    }
  }

  /** Get the number of subscribers for a channel */
  getSubscriberCount(channel: string): number {
    return this.channelSubscribers.get(channel)?.size ?? 0
  }

  /** Get all channels with at least one subscriber */
  getActiveChannels(): string[] {
    return Array.from(this.channelSubscribers.keys())
  }

  /** Get all channels a specific client is subscribed to */
  getClientSubscriptions(clientId: string): string[] {
    return Array.from(this.clientSubscriptions.get(clientId) ?? [])
  }

  /** Get the total number of connected clients */
  getClientCount(): number {
    return this.clients.size
  }

  /** Close the WebSocket server */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
