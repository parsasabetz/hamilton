// In-process event bus (HAMILTON.md §4.1) — stamps, persists, and fans out
// HamiltonEvents. Sequence allocation and persistence go through the brain
// handle; subscribers are broadcast synchronously for SSE fan-out.

import { getLogger } from "@logtape/logtape"
import type { EventType, HamiltonEvent } from "@hamilton/shared"
import type { BrainHandle } from "./runtime.ts"

const logger = getLogger(["hamilton", "core", "eventbus"])

export interface EmitInput {
  type: EventType
  runId: string
  taskId?: string
  agentId?: string
  payload: unknown
}

export interface BusOptions {
  brain: BrainHandle
  /** Used when an emit input has an empty runId. */
  runId?: string
}

export interface BusHandle {
  emit(input: EmitInput): Promise<HamiltonEvent>
  subscribe(listener: (event: HamiltonEvent) => void): () => void
  tail(runId: string, n: number): Promise<HamiltonEvent[]>
  stamp(input: EmitInput, seq: number): HamiltonEvent
}

const DEFAULT_RUN_ID = "local-run"
const EVENT_KEY_SEQ_PAD = 10

/** KV key for an event: `evt:<runId>:<seq>` with zero-padded seq. */
export function eventKey(runId: string, seq: number): string {
  return `evt:${runId}:${String(seq).padStart(EVENT_KEY_SEQ_PAD, "0")}`
}

/** Pure: stamp the bus-assigned fields onto an emit input. */
export function stamp(input: EmitInput, seq: number): HamiltonEvent {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    ts: new Date().toISOString(),
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    seq,
    payload: input.payload,
  }
}

/** Pure: last n events of an ascending list, ascending. */
export function pickTail(events: HamiltonEvent[], n: number): HamiltonEvent[] {
  return n <= 0 ? [] : events.slice(-n)
}

export function createBus(options: BusOptions): BusHandle {
  const listeners = new Set<(event: HamiltonEvent) => void>()

  return {
    async emit(input: EmitInput): Promise<HamiltonEvent> {
      const runId =
        input.runId === "" ? (options.runId ?? DEFAULT_RUN_ID) : input.runId
      const seq = await options.brain.nextSeq(runId)
      const event = stamp({ ...input, runId }, seq)
      await options.brain.appendEvent(event)
      await options.brain.emit(event)
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (err) {
          logger.error("Subscriber failed on event {id}: {error}", {
            id: event.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      logger.info("Emitted {id} {type} seq={seq}", {
        id: event.id,
        type: event.type,
        seq: event.seq,
      })
      return event
    },
    subscribe(listener: (event: HamiltonEvent) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    tail(runId: string, n: number): Promise<HamiltonEvent[]> {
      return options.brain.readEventTail(runId, n)
    },
    stamp,
  }
}
