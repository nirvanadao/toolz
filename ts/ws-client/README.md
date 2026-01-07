# @nirvana-tools/ws-client

Generic reconnecting WebSocket client with configurable heartbeat. Works in both browser and Node.js.

## Features

- **Auto-reconnect** with exponential backoff
- **Configurable heartbeat** with custom ping/pong messages
- **Heartbeat timeout detection** - knows when connection is dead
- **State tracking** - `connecting`, `connected`, `disconnected`, `reconnecting`, `closed`
- **Max retries** - optionally give up after N attempts
- **Works everywhere** - browser, React, Node.js (with `ws` package)

## Installation

```bash
pnpm add @nirvana-tools/ws-client
```

For Node.js/server usage, also install the `ws` package:

```bash
pnpm add ws
```

## Basic Usage

```ts
import { ReconnectingWebSocket } from "@nirvana-tools/ws-client"

const ws = new ReconnectingWebSocket("wss://api.example.com/ws", {
  onMessage: (data) => {
    console.log("Received:", data)
  },
  onStateChange: (state) => {
    console.log("Connection state:", state)
  },
})

ws.connect()

// Send messages
ws.send(JSON.stringify({ action: "subscribe", channel: "BTC" }))

// Check state
ws.isConnected()  // true/false
ws.getState()     // "connecting" | "connected" | "disconnected" | "reconnecting" | "closed"

// Close permanently
ws.close()
```

## Configuration Options

```ts
type ReconnectingWebSocketOptions = {
  // --- Required ---
  onMessage: (data: string) => void

  // --- Lifecycle callbacks ---
  onOpen?: () => void
  onClose?: () => void
  onError?: (error: Event | Error) => void
  onStateChange?: (state: ConnectionState) => void
  onHeartbeatTimeout?: () => void
  onReconnecting?: (attempt: number, nextDelayMs: number) => void
  onMaxRetriesExceeded?: () => void

  // --- Reconnect config ---
  reconnect?: boolean              // default: true
  reconnectDelay?: number          // default: 1000ms
  maxReconnectDelay?: number       // default: 30000ms
  maxRetries?: number              // default: undefined (infinite)

  // --- Heartbeat config ---
  heartbeatInterval?: number       // default: 30000ms (0 to disable)
  heartbeatTimeout?: number        // default: 5000ms
  createPingMessage?: () => string // default: '{"ping":1234567890}'
  isPongMessage?: (data: string) => boolean // default: checks for {"pong":...}
}
```

## Lifecycle & Alerting

### Connection Lifecycle Flow

```
                    ┌─────────────────────────────────────────────────────┐
                    │                                                     │
                    ▼                                                     │
    connect() → [connecting] → onOpen() → [connected] → heartbeat loop   │
                    │                          │                          │
                    │                          ▼                          │
                    │              onHeartbeatTimeout() ───┐              │
                    │                                      │              │
                    │         onClose() ←──────────────────┘              │
                    │              │                                      │
                    │              ▼                                      │
                    │     [reconnecting] ← onReconnecting(attempt, delay) │
                    │              │                                      │
                    │              ├─── retry < maxRetries ───────────────┘
                    │              │
                    │              └─── retry >= maxRetries
                    │                          │
                    │                          ▼
                    │              onMaxRetriesExceeded()
                    │                          │
                    │                          ▼
                    └──── close() ────→ [closed]
```

### Callback Firing Order

| Event | Callbacks fired (in order) |
|-------|---------------------------|
| Initial connect succeeds | `onStateChange("connecting")` → `onStateChange("connected")` → `onOpen()` |
| Connection drops | `onClose()` → `onStateChange("reconnecting")` → `onReconnecting(1, 1000)` |
| Heartbeat times out | `onHeartbeatTimeout()` → `onClose()` → `onStateChange("reconnecting")` → `onReconnecting(...)` |
| Reconnect succeeds | `onStateChange("connected")` → `onOpen()` |
| Max retries exceeded | `onReconnecting(N, ...)` → `onStateChange("closed")` → `onMaxRetriesExceeded()` |
| Manual close | `onStateChange("closed")` |

### Alerting Strategy

```ts
const ws = new ReconnectingWebSocket(url, {
  onMessage: handleMessage,

  // ─── Logging ───────────────────────────────────────────────
  onStateChange: (state) => {
    logger.info("WebSocket state", { state })
    metrics.gauge("ws_state", state === "connected" ? 1 : 0)
  },

  // ─── Early warning: connection dropped ─────────────────────
  onClose: () => {
    logger.warn("WebSocket disconnected")
  },

  // ─── Warning: heartbeat failed (stale connection) ──────────
  onHeartbeatTimeout: () => {
    logger.error("Heartbeat timeout - connection stale")
    metrics.increment("ws_heartbeat_timeout")
  },

  // ─── Track reconnect attempts ──────────────────────────────
  onReconnecting: (attempt, delayMs) => {
    logger.warn("Reconnecting", { attempt, delayMs })
    metrics.gauge("ws_reconnect_attempts", attempt)

    // Tier 1: Log warning after 3 failures
    if (attempt === 3) {
      alertSlack("⚠️ WebSocket reconnecting (attempt 3)")
    }

    // Tier 2: Page on-call after 10 failures (~2 min of retrying)
    if (attempt === 10) {
      alertPagerDuty("🔥 WebSocket connection unstable", "warning")
    }
  },

  // ─── Critical: gave up reconnecting ────────────────────────
  onMaxRetriesExceeded: () => {
    logger.error("WebSocket gave up reconnecting")
    alertPagerDuty("💀 WebSocket connection failed permanently", "critical")

    // Server: exit so orchestrator restarts us
    // process.exit(1)

    // Browser: show error UI
    // showConnectionError()
  },

  // ─── Config ────────────────────────────────────────────────
  maxRetries: 20,
  reconnectDelay: 1000,      // Start at 1s
  maxReconnectDelay: 30000,  // Cap at 30s
  heartbeatInterval: 30000,  // Ping every 30s
  heartbeatTimeout: 5000,    // Wait 5s for pong
})
```

### Retry Timeline (with defaults)

```
Time     Attempt   Delay    Total downtime
──────────────────────────────────────────
0s       —         —        Connection lost
1s       1         1s       1s
3s       2         2s       3s
7s       3         4s       7s       ← Alert Slack
15s      4         8s       15s
31s      5         16s      31s
1m 1s    6         30s      1m 1s    ← Capped at maxDelay
1m 31s   7         30s      1m 31s
2m 1s    8         30s      2m 1s
2m 31s   9         30s      2m 31s
3m 1s    10        30s      3m 1s    ← Alert PagerDuty
...
9m 1s    20        30s      9m 1s    ← onMaxRetriesExceeded
```

### Health Check Endpoint (Server)

Expose connection health for Kubernetes/load balancer probes:

```ts
import express from "express"

let wsHealthy = false
let lastHeartbeat = Date.now()

const ws = new ReconnectingWebSocket(url, {
  onMessage: handleMessage,

  onOpen: () => {
    wsHealthy = true
  },

  onClose: () => {
    wsHealthy = false
  },

  onHeartbeatTimeout: () => {
    wsHealthy = false
  },

  // Track last successful pong
  isPongMessage: (data) => {
    const isPong = data.includes('"pong"')
    if (isPong) lastHeartbeat = Date.now()
    return isPong
  },
})

const app = express()

// Liveness: process is running
app.get("/healthz", (req, res) => {
  res.status(200).send("OK")
})

// Readiness: WebSocket is connected and recent heartbeat
app.get("/readyz", (req, res) => {
  const staleThreshold = 60000 // 1 minute
  const isStale = Date.now() - lastHeartbeat > staleThreshold

  if (wsHealthy && !isStale) {
    res.status(200).send("READY")
  } else {
    res.status(503).json({
      ready: false,
      wsHealthy,
      lastHeartbeat: new Date(lastHeartbeat).toISOString(),
      staleSec: Math.floor((Date.now() - lastHeartbeat) / 1000),
    })
  }
})
```

## Custom Heartbeat

Different APIs have different ping/pong formats. Configure yours:

```ts
const ws = new ReconnectingWebSocket(url, {
  onMessage: handleMessage,

  // Your API's ping format
  createPingMessage: () => JSON.stringify({
    type: "ping",
    timestamp: Date.now()
  }),

  // How to detect pong responses
  isPongMessage: (data) => {
    try {
      const msg = JSON.parse(data)
      return msg.type === "pong"
    } catch {
      return false
    }
  },

  heartbeatInterval: 15000,  // Ping every 15s
  heartbeatTimeout: 5000,    // Wait 5s for pong

  onHeartbeatTimeout: () => {
    console.warn("Heartbeat timeout - connection dead")
    // Connection will auto-close and reconnect
  },
})
```

## React Browser Example

```tsx
import { useEffect, useRef, useState } from "react"
import { ReconnectingWebSocket, ConnectionState } from "@nirvana-tools/ws-client"

function useMarketData(symbols: string[]) {
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [state, setState] = useState<ConnectionState>("disconnected")
  const wsRef = useRef<ReconnectingWebSocket | null>(null)

  useEffect(() => {
    const ws = new ReconnectingWebSocket("wss://api.example.com/ws", {
      onMessage: (data) => {
        const msg = JSON.parse(data)
        if (msg.price) {
          setPrices(prev => ({ ...prev, [msg.symbol]: msg.price }))
        }
      },
      onStateChange: setState,
      onOpen: () => {
        // Subscribe on connect/reconnect
        ws.send(JSON.stringify({ subscribe: symbols }))
      },
      onMaxRetriesExceeded: () => {
        console.error("Connection failed permanently")
      },
      maxRetries: 10,
    })

    wsRef.current = ws
    ws.connect()

    return () => ws.close()
  }, [symbols.join(",")])

  return { prices, state, isConnected: state === "connected" }
}

// Usage in component
function PriceDisplay() {
  const { prices, isConnected } = useMarketData(["BTC", "ETH"])

  return (
    <div>
      <div>Status: {isConnected ? "🟢" : "🔴"}</div>
      <div>BTC: ${prices.BTC}</div>
      <div>ETH: ${prices.ETH}</div>
    </div>
  )
}
```

## Wrapping with MarketSubscriber Class

For complex protocols, wrap the base WebSocket:

```ts
import { ReconnectingWebSocket, ConnectionState } from "@nirvana-tools/ws-client"

type MarketData = {
  symbol: string
  price: number
  volume: number
}

type MarketSubscriberOptions = {
  onData: (data: MarketData) => void
  onStateChange?: (state: ConnectionState) => void
  onError?: (error: string) => void
}

export class MarketSubscriber {
  private ws: ReconnectingWebSocket
  private subscriptions = new Set<string>()
  private options: MarketSubscriberOptions

  constructor(url: string, options: MarketSubscriberOptions) {
    this.options = options

    this.ws = new ReconnectingWebSocket(url, {
      onMessage: this.handleMessage,
      onOpen: this.handleOpen,
      onStateChange: options.onStateChange,

      // Custom ping/pong for this API
      createPingMessage: () => JSON.stringify({ action: "ping" }),
      isPongMessage: (data) => data.includes('"action":"pong"'),

      heartbeatInterval: 30000,
      heartbeatTimeout: 5000,
      maxRetries: 20,
    })
  }

  private handleMessage = (raw: string) => {
    try {
      const msg = JSON.parse(raw)

      if (msg.error) {
        this.options.onError?.(msg.error)
        return
      }

      if (msg.type === "market_data") {
        this.options.onData({
          symbol: msg.symbol,
          price: msg.price,
          volume: msg.volume,
        })
      }
    } catch (e) {
      console.error("Failed to parse message:", raw)
    }
  }

  private handleOpen = () => {
    // Resubscribe to all channels on reconnect
    if (this.subscriptions.size > 0) {
      this.ws.send(JSON.stringify({
        action: "subscribe",
        symbols: Array.from(this.subscriptions),
      }))
    }
  }

  subscribe(symbols: string[]): void {
    for (const s of symbols) {
      this.subscriptions.add(s)
    }
    if (this.ws.isConnected()) {
      this.ws.send(JSON.stringify({ action: "subscribe", symbols }))
    }
  }

  unsubscribe(symbols: string[]): void {
    for (const s of symbols) {
      this.subscriptions.delete(s)
    }
    if (this.ws.isConnected()) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", symbols }))
    }
  }

  connect(): void {
    this.ws.connect()
  }

  close(): void {
    this.ws.close()
  }

  isConnected(): boolean {
    return this.ws.isConnected()
  }

  getState(): ConnectionState {
    return this.ws.getState()
  }
}
```

Usage:

```ts
const subscriber = new MarketSubscriber("wss://api.example.com/ws", {
  onData: (data) => {
    console.log(`${data.symbol}: $${data.price}`)
  },
  onStateChange: (state) => {
    console.log("Connection:", state)
  },
})

subscriber.connect()
subscriber.subscribe(["BTC", "ETH", "SOL"])
```

## Node.js Server Example

For server-side usage (e.g., a data pipeline), install `ws`:

```bash
pnpm add ws
pnpm add -D @types/ws
```

Then use with global WebSocket:

```ts
import WebSocket from "ws"
import { ReconnectingWebSocket } from "@nirvana-tools/ws-client"

// Make ws available globally (Node.js doesn't have built-in WebSocket)
;(globalThis as any).WebSocket = WebSocket

const ws = new ReconnectingWebSocket("wss://stream.example.com/ws", {
  onMessage: (data) => {
    const msg = JSON.parse(data)
    // Process and forward to your pipeline
    publishToPubSub(msg)
  },
  onStateChange: (state) => {
    logger.info("WebSocket state changed", { state })
  },
  onHeartbeatTimeout: () => {
    logger.warn("Heartbeat timeout, reconnecting...")
  },
  onMaxRetriesExceeded: () => {
    logger.error("WebSocket connection failed permanently")
    process.exit(1) // Or alert, restart, etc.
  },
  maxRetries: 50,
  heartbeatInterval: 15000,
})

ws.connect()

// Graceful shutdown
process.on("SIGTERM", () => {
  ws.close()
  process.exit(0)
})
```

## Error Handling

```ts
const ws = new ReconnectingWebSocket(url, {
  onMessage: handleMessage,

  onError: (error) => {
    // WebSocket error (connection refused, etc.)
    console.error("WebSocket error:", error)
  },

  onHeartbeatTimeout: () => {
    // Connection went silent - will auto-reconnect
    console.warn("Heartbeat timeout")
  },

  onMaxRetriesExceeded: () => {
    // Gave up reconnecting
    console.error("Connection failed after max retries")

    // Options:
    // 1. Show error UI to user
    // 2. Try again later: setTimeout(() => ws.reconnect(), 60000)
    // 3. Exit process (server)
  },

  maxRetries: 10,
})
```

## Methods

| Method | Description |
|--------|-------------|
| `connect()` | Start the connection |
| `close()` | Close permanently (no reconnect) |
| `reconnect()` | Reset and reconnect (after close or max retries) |
| `send(data: string)` | Send a message. Returns `false` if not connected |
| `ping()` | Manually trigger a heartbeat ping |
| `isConnected()` | Returns `true` if connected |
| `getState()` | Get current connection state |
| `getRetryCount()` | Get number of retries since last successful connection |

## License

MIT
