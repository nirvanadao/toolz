import { CloudRunLogger } from "@nirvana-tools/cloud-run-logger"
import { HeliusWebhookPayload } from "./types"

/** Create a debug handler that logs all webhook payloads */
export function createDebugHandler(logger: CloudRunLogger) {
  return async (payloads: HeliusWebhookPayload[]) => {
    for (const payload of payloads) {
      logger.debug("Helius webhook event", {
        signature: payload.signature,
        slot: payload.slot,
        type: payload.type,
        source: payload.source,
        feePayer: payload.feePayer,
        nativeTransfers: payload.nativeTransfers?.length ?? 0,
        tokenTransfers: payload.tokenTransfers?.length ?? 0,
      })
    }
  }
}
