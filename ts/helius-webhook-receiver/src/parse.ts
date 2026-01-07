import { HeliusWebhookPayload } from "./types"

/** Parse and validate webhook payload from raw request body */
export function parseHeliusWebhook(body: unknown): HeliusWebhookPayload[] {
  if (!body) {
    return []
  }
  // Helius sends an array of events
  const payloads = Array.isArray(body) ? body : [body]
  return payloads as HeliusWebhookPayload[]
}
