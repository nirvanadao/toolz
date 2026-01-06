# @nirvana-tools/ws-client

WebSocket client for subscribing to channels and receiving push notifications. Designed for use with `@nirvana-tools/ws-server`.

## Installation

```bash
pnpm add @nirvana-tools/ws-client
```

## Basic Usage

```typescript
import { WebSocketClient } from "@nirvana-tools/ws-client"

const client = new WebSocketClient("ws://localhost:3000/ws", {
  onMessage: (channel, data) => console.log(`${channel}: ${data}`),
  onError: (error, channel) => console.log(`Error: ${error} for ${channel}`),
  onConnect: () => console.log("Connected"),
  onDisconnect: () => console.log("Disconnected"),
})

client.subscribe(["BTC", "ETH"])
client.unsubscribe(["ETH"])
client.close()
```

## React/Next.js Singleton Pattern

For React apps, use a singleton to share one WebSocket connection across all components.

**lib/ws.ts**
```typescript
import { WebSocketClient } from "@nirvana-tools/ws-client"

type Listener = (data: string) => void

class PriceSocket {
  private client: WebSocketClient | null = null
  private listeners = new Map<string, Set<Listener>>()

  private getClient(): WebSocketClient {
    if (!this.client) {
      this.client = new WebSocketClient(process.env.NEXT_PUBLIC_WS_URL!, {
        onMessage: (channel, data) => {
          this.listeners.get(channel)?.forEach((fn) => fn(data))
        },
      })
    }
    return this.client
  }

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
      this.getClient().subscribe([channel])
    }
    set.add(listener)

    return () => {
      set!.delete(listener)
      if (set!.size === 0) {
        this.listeners.delete(channel)
        this.client?.unsubscribe([channel])
      }
    }
  }
}

export const priceSocket = new PriceSocket()
```

**hooks/usePrice.ts**
```typescript
import { useEffect, useState } from "react"
import { priceSocket } from "@/lib/ws"

export function usePrice(ticker: string) {
  const [price, setPrice] = useState<number | null>(null)

  useEffect(() => {
    return priceSocket.subscribe(ticker, (data) => {
      setPrice(JSON.parse(data).price)
    })
  }, [ticker])

  return price
}
```

**Usage in components**
```typescript
function BitcoinPrice() {
  const price = usePrice("BTC")
  return <div>BTC: ${price}</div>
}

function Dashboard() {
  return (
    <>
      <BitcoinPrice />
      <BitcoinPrice />  {/* Same channel, different listener */}
      <EthereumPrice />
    </>
  )
}
```

## API

### Constructor

```typescript
new WebSocketClient(url: string, options: WebSocketClientOptions)
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onMessage` | `(channel, data) => void` | required | Called when a message is received |
| `onError` | `(error, channel?) => void` | - | Called on error (e.g., invalid channel) |
| `onConnect` | `() => void` | - | Called when connected |
| `onDisconnect` | `() => void` | - | Called when disconnected |
| `reconnect` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnectDelay` | `number` | `1000` | Reconnect delay in ms |

### Methods

| Method | Description |
|--------|-------------|
| `subscribe(channels: string[])` | Subscribe to channels |
| `unsubscribe(channels: string[])` | Unsubscribe from channels |
| `getSubscriptions(): string[]` | Get current subscriptions |
| `isConnected(): boolean` | Check connection status |
| `close()` | Close connection permanently |
