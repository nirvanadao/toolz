/**
 * Generic reconnecting WebSocket client with configurable heartbeat.
 * Works in both browser and Node.js (with 'ws' package).
 *
 * Wrap this with protocol-specific logic (e.g., market-subscriber).
 */

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting" | "closed"

export type ReconnectingWebSocketOptions = {
  /** Called when a message is received (raw string) */
  onMessage: (data: string) => void

  /** Called when connection is established */
  onOpen?: () => void

  /** Called when connection is lost (will reconnect unless closed) */
  onClose?: () => void

  /** Called when a WebSocket error occurs */
  onError?: (error: Event | Error) => void

  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void

  /** Called when heartbeat times out (connection presumed dead) */
  onHeartbeatTimeout?: () => void

  /** Called when max reconnect attempts exceeded. Connection is now closed. */
  onMaxRetriesExceeded?: () => void

  /** Called on each reconnect attempt. Use to track/alert on repeated failures. */
  onReconnecting?: (attempt: number, nextDelayMs: number) => void

  // --- Reconnect config ---

  /** Auto-reconnect on disconnect (default: true) */
  reconnect?: boolean

  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelay?: number

  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number

  /** Max reconnect attempts before giving up. undefined = infinite (default) */
  maxRetries?: number

  // --- Heartbeat config ---

  /** Heartbeat interval in ms (default: 30000). Set to 0 to disable. */
  heartbeatInterval?: number

  /** How long to wait for pong before considering connection dead (default: 5000) */
  heartbeatTimeout?: number

  /** Create the ping message to send. Default: '{"ping":true}' */
  createPingMessage?: () => string

  /** Check if a message is a pong response. Default: checks for {"pong":...} */
  isPongMessage?: (data: string) => boolean
}

const DEFAULT_PING = () => JSON.stringify({ ping: Date.now() })
const DEFAULT_IS_PONG = (data: string) => {
  try {
    const msg = JSON.parse(data)
    return "pong" in msg
  } catch {
    return false
  }
}

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null
  private url: string
  private options: ReconnectingWebSocketOptions
  private state: ConnectionState = "disconnected"
  private retryCount = 0
  private currentDelay: number
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private awaitingPong = false

  constructor(url: string, options: ReconnectingWebSocketOptions) {
    this.url = url
    this.options = options
    this.currentDelay = options.reconnectDelay ?? 1000
  }

  /** Connect to the WebSocket server. Call this to start. */
  connect(): void {
    if (this.state === "closed") return
    this.setState("connecting")
    this.createConnection()
  }

  private createConnection(): void {
    if (this.state === "closed") return

    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.retryCount = 0
      this.currentDelay = this.options.reconnectDelay ?? 1000
      this.setState("connected")
      this.startHeartbeat()
      this.options.onOpen?.()
    }

    this.ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data)

      // Check if it's a pong response
      const isPong = (this.options.isPongMessage ?? DEFAULT_IS_PONG)(data)
      if (isPong) {
        this.handlePong()
        return
      }

      this.options.onMessage(data)
    }

    this.ws.onclose = () => {
      this.stopHeartbeat()
      this.ws = null

      if (this.state === "closed") return

      this.options.onClose?.()
      this.maybeReconnect()
    }

    this.ws.onerror = (error) => {
      this.options.onError?.(error)
      // onclose will fire after onerror, which handles reconnection
    }
  }

  private maybeReconnect(): void {
    if (this.state === "closed") return
    if (this.options.reconnect === false) {
      this.setState("disconnected")
      return
    }

    const maxRetries = this.options.maxRetries
    if (maxRetries !== undefined && this.retryCount >= maxRetries) {
      this.setState("closed")
      this.options.onMaxRetriesExceeded?.()
      return
    }

    this.setState("reconnecting")
    this.retryCount++

    // Notify with current attempt and delay
    this.options.onReconnecting?.(this.retryCount, this.currentDelay)

    setTimeout(() => {
      if (this.state === "closed") return
      this.createConnection()
    }, this.currentDelay)

    // Exponential backoff
    const maxDelay = this.options.maxReconnectDelay ?? 30000
    this.currentDelay = Math.min(this.currentDelay * 2, maxDelay)
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatInterval ?? 30000
    if (interval <= 0) return

    this.heartbeatTimer = setInterval(() => {
      this.sendPing()
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearPongTimer()
  }

  private sendPing(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    if (this.awaitingPong) {
      // Previous ping never got a pong - connection is dead
      this.handleHeartbeatTimeout()
      return
    }

    const pingMsg = (this.options.createPingMessage ?? DEFAULT_PING)()
    this.ws.send(pingMsg)
    this.awaitingPong = true

    // Start pong timeout
    const timeout = this.options.heartbeatTimeout ?? 5000
    this.pongTimer = setTimeout(() => {
      if (this.awaitingPong) {
        this.handleHeartbeatTimeout()
      }
    }, timeout)
  }

  private handlePong(): void {
    this.awaitingPong = false
    this.clearPongTimer()
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    this.awaitingPong = false
  }

  private handleHeartbeatTimeout(): void {
    this.options.onHeartbeatTimeout?.()
    // Force close - will trigger reconnect
    this.ws?.close()
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return
    this.state = state
    this.options.onStateChange?.(state)
  }

  /** Send a raw message. Returns false if not connected. */
  send(data: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(data)
    return true
  }

  /** Manually trigger a ping. */
  ping(): void {
    this.sendPing()
  }

  /** Get current connection state. */
  getState(): ConnectionState {
    return this.state
  }

  /** Get number of reconnect attempts since last successful connection. */
  getRetryCount(): number {
    return this.retryCount
  }

  /** Returns true if connected. */
  isConnected(): boolean {
    return this.state === "connected" && this.ws?.readyState === WebSocket.OPEN
  }

  /** Close permanently. No reconnect. */
  close(): void {
    this.setState("closed")
    this.stopHeartbeat()
    this.ws?.close()
    this.ws = null
  }

  /** Reset and reconnect (useful after close or max retries). */
  reconnect(): void {
    this.close()
    this.state = "disconnected" // Allow connect() to work
    this.retryCount = 0
    this.currentDelay = this.options.reconnectDelay ?? 1000
    this.connect()
  }
}
