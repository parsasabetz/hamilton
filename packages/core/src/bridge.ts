// OpenCode SSE bridge (HAMILTON.md §8.4) — the orchestrator's eyes on its agents.
//
// Agents run in their own OpenCode sessions; the ONLY way to learn they are
// stuck, quiet, or crashed is the low-level event stream. This module:
//
//   1. subscribes to the opencode server's /event SSE stream (v2 client)
//   2. classifies every raw event and re-emits it as `telemetry.opencode`
//      (audit + dashboard + RunDO policy input)
//   3. watches each TRACKED session (only sessions the orchestrator owns):
//        - `agent.stalled`  — session busy (mid-turn) with no stream activity
//          for stallTimeoutMs → model hung or a tool call is stuck
//        - `agent.idle`     — session transitioned busy → idle (turn ended);
//          RunDO combines with task state to detect silent quits
//   4. reconnects with backoff and signals `telemetry.stream_lost` /
//      `telemetry.stream_reconnected` so RunDO knows when liveness data is
//      trustworthy
//
// Heartbeats (MCP) remain a secondary signal: they are model-driven and
// fallible — a stuck agent cannot heartbeat. The stream is authoritative.
//
// Mitigation for stuck tool calls (constant layer): start opencode with
// OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS so no bash call runs forever.

import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { EventType, HamiltonEvent } from "@hamilton/shared"

/** Structural shape of a raw opencode event — tolerant to SDK version drift. */
export interface RawOpencodeEvent {
  id?: string
  type: string
  properties: Record<string, unknown>
}

/** A Hamilton event without the bus-assigned fields (id, seq). */
export type BridgeEvent = Omit<HamiltonEvent, "id" | "seq">

export interface BridgeOptions {
  baseUrl: string
  /** runId stamped on events without a tracked session. */
  runId?: string
  /** Busy session with no stream activity for this long → agent.stalled. */
  stallTimeoutMs?: number
  /** How often the stall sweep runs. */
  sweepIntervalMs?: number
  /** Cap for the SSE reconnect backoff. */
  maxReconnectDelayMs?: number
}

export interface TrackContext {
  runId: string
  taskId?: string
}

export interface BridgeHandle {
  start(): Promise<void>
  stop(): void
  /** Start watching a session the orchestrator owns (call on dispatch). */
  track(sessionId: string, context: TrackContext): void
  /** Stop watching a session (call on task completion/abort). */
  untrack(sessionId: string): void
}

const DEFAULT_OPTIONS = {
  stallTimeoutMs: 180_000,
  sweepIntervalMs: 10_000,
  maxReconnectDelayMs: 30_000,
}

export type RawEventKind = "activity" | "idle" | "status" | "error" | "other"

/** Pure classification of a raw opencode event (unit-tested). */
export function classifyRawEvent(raw: RawOpencodeEvent): {
  kind: RawEventKind
  sessionId?: string
} {
  const props = raw.properties
  const sessionId =
    typeof props["sessionID"] === "string" ? props["sessionID"] : undefined
  if (raw.type === "session.idle") return { kind: "idle", sessionId }
  if (raw.type === "session.status") return { kind: "status", sessionId }
  if (raw.type === "session.error") return { kind: "error", sessionId }
  if (sessionId) return { kind: "activity", sessionId }
  return { kind: "other" }
}

function isBusyStatus(status: unknown): boolean {
  return (
    typeof status === "object" &&
    status !== null &&
    (status as { type?: unknown }).type === "busy"
  )
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface SessionWatch {
  sessionId: string
  runId: string
  taskId?: string
  lastActivityAt: number
  busy: boolean
  stalled: boolean
  idleNotified: boolean
}

export function createBridge(
  options: BridgeOptions,
  onEvent: (event: BridgeEvent) => void,
): BridgeHandle {
  const cfg = { ...DEFAULT_OPTIONS, ...options }
  const client = createOpencodeClient({ baseUrl: cfg.baseUrl })
  const watches = new Map<string, SessionWatch>()

  let stopped = false
  let sweep: ReturnType<typeof setInterval> | undefined
  let currentGen: AsyncGenerator<unknown> | undefined

  function emit(
    type: EventType,
    watch: SessionWatch | undefined,
    payload: unknown,
  ): void {
    onEvent({
      type,
      ts: new Date().toISOString(),
      runId: watch?.runId ?? cfg.runId ?? "local",
      ...(watch?.taskId ? { taskId: watch.taskId } : {}),
      ...(watch ? { agentId: watch.sessionId } : {}),
      payload,
    })
  }

  function handle(raw: RawOpencodeEvent): void {
    const cls = classifyRawEvent(raw)
    const watch = cls.sessionId ? watches.get(cls.sessionId) : undefined
    emit("telemetry.opencode", watch, {
      eventId: raw.id,
      opencodeType: raw.type,
      sessionId: cls.sessionId,
      properties: raw.properties,
    })
    if (!watch) return
    switch (cls.kind) {
      case "activity":
        watch.lastActivityAt = Date.now()
        watch.stalled = false
        watch.busy = true
        watch.idleNotified = false
        break
      case "idle":
        if (watch.busy && !watch.idleNotified) {
          watch.idleNotified = true
          emit("agent.idle", watch, { sessionId: watch.sessionId })
        }
        watch.busy = false
        break
      case "status":
        watch.busy = isBusyStatus(raw.properties["status"])
        break
      case "error":
        // RunDO applies policy to the telemetry.opencode passthrough.
        break
      default:
        break
    }
  }

  function sweepOnce(): void {
    const nowMs = Date.now()
    for (const watch of watches.values()) {
      if (
        watch.busy &&
        !watch.stalled &&
        nowMs - watch.lastActivityAt >= cfg.stallTimeoutMs
      ) {
        watch.stalled = true
        emit("agent.stalled", watch, {
          sessionId: watch.sessionId,
          silentForMs: nowMs - watch.lastActivityAt,
        })
      }
    }
  }

  async function run(): Promise<void> {
    let attempt = 0
    // Reconnect loop: sequential by design — re-subscribe, drain, backoff.
    // oxlint-disable-next-line no-await-in-loop
    /* oxlint-disable no-unmodified-loop-condition -- `stopped` flips from stop() */
    while (!stopped) {
      // oxlint-disable-next-line no-await-in-loop
      try {
        // oxlint-disable-next-line no-await-in-loop
        const result = await client.event.subscribe()
        currentGen = result.stream
        if (attempt > 0) {
          emit("telemetry.stream_reconnected", undefined, { attempt })
        }
        attempt = 0
        // oxlint-disable-next-line no-await-in-loop
        for await (const raw of result.stream) {
          handle(raw as RawOpencodeEvent)
        }
        emit("telemetry.stream_lost", undefined, { reason: "stream ended" })
      } catch (err) {
        emit("telemetry.stream_lost", undefined, {
          reason: err instanceof Error ? err.message : String(err),
        })
      }
      currentGen = undefined
      if (stopped) break
      attempt += 1
      // oxlint-disable-next-line no-await-in-loop
      await sleep(Math.min(2 ** attempt * 1000, cfg.maxReconnectDelayMs))
    }
    /* oxlint-enable no-unmodified-loop-condition */
  }

  return {
    async start(): Promise<void> {
      stopped = false
      sweep = setInterval(sweepOnce, cfg.sweepIntervalMs)
      void run()
    },
    stop(): void {
      stopped = true
      if (sweep) clearInterval(sweep)
      currentGen?.return(undefined).catch(() => {})
    },
    track(sessionId: string, context: TrackContext): void {
      watches.set(sessionId, {
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        lastActivityAt: Date.now(),
        busy: false,
        stalled: false,
        idleNotified: false,
      })
    },
    untrack(sessionId: string): void {
      watches.delete(sessionId)
    },
  }
}
