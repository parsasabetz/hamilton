// OpenCode control plane (HAMILTON.md §8) — typed client over the SDK.
// Connects to a running `opencode serve` instance (default 127.0.0.1:4096).

import { createOpencodeClient } from "@opencode-ai/sdk/v2"

export interface ControlPlaneOptions {
  baseUrl?: string
}

export function createControlPlane(options: ControlPlaneOptions = {}) {
  const baseUrl = options.baseUrl ?? "http://localhost:4096"
  const client = createOpencodeClient({ baseUrl })
  return {
    client,
    baseUrl,
    async health() {
      const result = await client.global.health()
      return result.data ?? null
    },
  }
}

export type ControlPlane = ReturnType<typeof createControlPlane>
