// HTTP shim to the Hamilton Core (HAMILTON.md §7, M1) — emits events onto the
// event bus via POST {coreUrl}/api/events. Never throws; every failure comes
// back as EmitResult { ok: false }.

import { hamiltonEventTypes } from "@hamilton/shared"
import type { EventType } from "@hamilton/shared"

export interface ShimConfig {
  coreUrl?: string
  runId?: string
  taskId?: string
  agentId?: string
}

export interface EmitResult {
  ok: boolean
  eventId?: string
  seq?: number
  error?: string
}

export interface ShimHandle {
  emit(type: string, payload: unknown): Promise<EmitResult>
}

const DEFAULT_CORE_URL = "http://localhost:8787"
const DEFAULT_RUN_ID = "local-run"
const EMIT_TIMEOUT_MS = 5000

// Single source of truth from @hamilton/shared — unknown types are rejected
// locally without a network call.
const eventTypeSet: ReadonlySet<string> = new Set(hamiltonEventTypes)

export function isEventType(value: string): value is EventType {
  return eventTypeSet.has(value)
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return String(error)
}

function parseEmitResponse(data: unknown): { id: string; seq: number } | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record["id"] !== "string" || typeof record["seq"] !== "number") {
    return null
  }
  return { id: record["id"], seq: record["seq"] }
}

export function createShim(config?: ShimConfig): ShimHandle {
  const coreUrl =
    config?.coreUrl ?? process.env.HAMILTON_CORE_URL ?? DEFAULT_CORE_URL
  const runId = config?.runId ?? process.env.HAMILTON_RUN_ID ?? DEFAULT_RUN_ID
  const taskId = config?.taskId ?? process.env.HAMILTON_TASK_ID
  const agentId = config?.agentId ?? process.env.HAMILTON_AGENT_ID

  return {
    async emit(type: string, payload: unknown): Promise<EmitResult> {
      if (!isEventType(type)) {
        return { ok: false, error: "unknown event type" }
      }
      const body: Record<string, unknown> = { type, runId, payload }
      if (taskId !== undefined) body["taskId"] = taskId
      if (agentId !== undefined) body["agentId"] = agentId
      try {
        const response = await fetch(`${coreUrl}/api/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(EMIT_TIMEOUT_MS),
        })
        if (!response.ok) {
          return { ok: false, error: `core responded ${response.status}` }
        }
        const parsed = parseEmitResponse(await response.json())
        if (parsed === null) {
          return { ok: false, error: "unexpected core response" }
        }
        return { ok: true, eventId: parsed.id, seq: parsed.seq }
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      }
    },
  }
}
