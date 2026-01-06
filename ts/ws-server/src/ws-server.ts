import { Server as HttpServer } from "http"
import { WebSocketServer as WsServer, WebSocket } from "ws"

export interface WebSocketServerOptions {
  /** Path for WebSocket connections (e.g., "/ws"). If not set, accepts all paths. */
  path?: string
  /** Validate a channel name before subscribing. Return false to reject. */
  isValidChannel?: (channel: string) => boolean | Promise<boolean>
  /** Called when the first client subscribes to a channel. Use this to set up upstream subscriptions (e.g., Redis). */
  onSubscribe: (channel: string) => void | Promise<void>
  /** Called when the last client unsubscribes from a channel. Use this to tear down upstream subscriptions. */
  onUnsubscribe: (channel: string) => void | Promise<void>
  /** Called on WebSocket errors */
  onError?: (error: Error) => void
}

interface ClientMessage {
  subscribe?: string[]
  unsubscribe?: string[]
  ping?: boolean
}

/**
 * Broadcast WebSocket server for Express with multi-channel subscriptions.
 *
 * Clients connect and send JSON messages to subscribe/unsubscribe from channels.
 * The server invokes `onSubscribe` when a channel gains its first client and
 * `onUnsubscribe` when a channel loses its last client, enabling efficient
 * upstream resource management (e.g., Redis pub/sub).
 *
 * @example
 * ```typescript
 * const wss = new WebSocketServer(httpServer, {
 *   onSubscribe: (channel) => redis.subscribe(channel),
 *   onUnsubscribe: (channel) => redis.unsubscribe(channel),
 * })
 *
 * // Push updates from Redis to WebSocket clients
 * redis.on("message", (channel, data) => {
 *   wss.broadcast(channel, data)
 * })
 * ```
 *
 * Client usage:
 * ```javascript
 * const ws = new WebSocket("ws://host/ws")
 * ws.send(JSON.stringify({ subscribe: ["BTC", "ETH"] }))
 * ws.send(JSON.stringify({ unsubscribe: ["ETH"] }))
 * ```
 */
export class WebSocketServer {
  private wss: WsServer
  private clientChannels = new Map<WebSocket, Set<string>>()
  private channelClients = new Map<string, Set<WebSocket>>()
  private options: WebSocketServerOptions

  /**
   * Creates a new WebSocket server attached to an HTTP server.
   * @param server - The HTTP server (from Express or http.createServer)
   * @param options - Configuration including subscription callbacks
   */
  constructor(server: HttpServer, options: WebSocketServerOptions) {
    this.options = options
    this.wss = new WsServer({ server, path: options.path })
    this.wss.on("connection", (ws) => this.handleConnection(ws))
  }

  private handleConnection(ws: WebSocket): void {
    this.clientChannels.set(ws, new Set())

    ws.on("message", (data) => this.handleMessage(ws, data))
    ws.on("close", () => this.handleDisconnect(ws))
    ws.on("error", (err) => this.options.onError?.(err))
  }

  private async handleMessage(ws: WebSocket, rawData: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    let message: ClientMessage
    try {
      message = JSON.parse(rawData.toString())
    } catch {
      return
    }

    if (message.ping) {
      ws.send(JSON.stringify({ pong: true }))
      return
    }

    if (message.subscribe) {
      for (const channel of message.subscribe) {
        await this.subscribe(ws, channel)
      }
    }

    if (message.unsubscribe) {
      for (const channel of message.unsubscribe) {
        await this.unsubscribe(ws, channel)
      }
    }
  }

  private async subscribe(ws: WebSocket, channel: string): Promise<void> {
    const channels = this.clientChannels.get(ws)
    if (!channels || channels.has(channel)) return

    if (this.options.isValidChannel) {
      const valid = await this.options.isValidChannel(channel)
      if (!valid) {
        ws.send(JSON.stringify({ error: "invalid_channel", channel }))
        return
      }
    }

    channels.add(channel)

    let clients = this.channelClients.get(channel)
    const isFirst = !clients

    if (!clients) {
      clients = new Set()
      this.channelClients.set(channel, clients)
    }
    clients.add(ws)

    if (isFirst) {
      await this.options.onSubscribe(channel)
    }
  }

  private async unsubscribe(ws: WebSocket, channel: string): Promise<void> {
    const channels = this.clientChannels.get(ws)
    if (!channels || !channels.has(channel)) return

    channels.delete(channel)

    const clients = this.channelClients.get(channel)
    if (clients) {
      clients.delete(ws)
      if (clients.size === 0) {
        this.channelClients.delete(channel)
        await this.options.onUnsubscribe(channel)
      }
    }
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const channels = this.clientChannels.get(ws)
    if (channels) {
      for (const channel of channels) {
        const clients = this.channelClients.get(channel)
        if (clients) {
          clients.delete(ws)
          if (clients.size === 0) {
            this.channelClients.delete(channel)
            await this.options.onUnsubscribe(channel)
          }
        }
      }
    }
    this.clientChannels.delete(ws)
  }

  /**
   * Broadcasts a string payload to all clients subscribed to a channel.
   * @param channel - The channel to broadcast to
   * @param data - The string payload to send (pre-serialized)
   */
  broadcast(channel: string, data: string): void {
    const clients = this.channelClients.get(channel)
    if (!clients) return

    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

  /**
   * Returns the number of clients subscribed to a channel.
   * @param channel - The channel to check
   * @returns The subscriber count (0 if channel has no subscribers)
   */
  getSubscriberCount(channel: string): number {
    return this.channelClients.get(channel)?.size ?? 0
  }

  /**
   * Returns all channels that currently have at least one client.
   * @returns Array of active channel names
   */
  getActiveChannels(): string[] {
    return Array.from(this.channelClients.keys())
  }

  /**
   * Returns the total number of connected clients.
   * @returns The count of connected WebSocket clients
   */
  getClientCount(): number {
    return this.clientChannels.size
  }

  /**
   * Closes the WebSocket server and terminates all client connections.
   * @returns Promise that resolves when the server is fully closed
   */
  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
