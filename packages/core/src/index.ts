// Hamilton Core — the Bun executor (HAMILTON.md §3).
// M1: the event spine — Miniflare brain + event bus + SSE hub + HTTP routes,
// started via the `hamilton` CLI.

import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"
import { hamiltonEventTypes } from "@hamilton/shared"
import type { HamiltonEvent } from "@hamilton/shared"

import { createBridge } from "./bridge.ts"
import { createBus } from "./eventbus.ts"
import type { EmitInput } from "./eventbus.ts"
import { createBrain } from "./runtime.ts"
import { statusPage } from "./status-page.ts"

export * from "./bridge.ts"
export * from "./eventbus.ts"
export * from "./opencode.ts"
export * from "./runtime.ts"
export * from "./status-page.ts"

export interface CoreOptions {
  port?: number
  /** Miniflare persist dir for KV/R2/DO state (inside the repo; default ".mf"). */
  persistDir?: string
  /** Default run id stamped on events without one (default "local-run"). */
  runId?: string
  /** baseUrl of a running `opencode serve` — starts the SSE bridge when set. */
  opencodeUrl?: string
}

export interface CoreHandle {
  url: string
  emit(input: EmitInput): Promise<HamiltonEvent>
  stop(): Promise<void>
  /** The Miniflare brain — exposed for tests and debugging. */
  brain: Awaited<ReturnType<typeof createBrain>>
}

configureSync({
  sinks: { console: getConsoleSink() },
  filters: { "*": "info" },
  loggers: [
    { category: ["hamilton"], lowestLevel: "info", sinks: ["console"] },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
})

const logger = getLogger(["hamilton", "core"])

const VERSION = "0.0.0"
const PING_INTERVAL_MS = 5000

function jsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export async function startCore(
  options: CoreOptions = {},
): Promise<CoreHandle> {
  const port = options.port ?? 8787
  const persistDir = options.persistDir ?? ".mf"
  const defaultRunId = options.runId ?? "local-run"

  const brain = await createBrain({ persistDir })
  const bus = createBus({ brain, runId: defaultRunId })

  const listeners = new Set<(event: HamiltonEvent) => void>()
  bus.subscribe((event) => {
    for (const listener of listeners) listener(event)
  })

  const opencodeUrl = options.opencodeUrl ?? process.env.HAMILTON_OPCODE_URL
  const bridge = opencodeUrl
    ? createBridge({ baseUrl: opencodeUrl, runId: defaultRunId }, (event) => {
        void bus.emit(event)
      })
    : undefined

  const server = Bun.serve({
    port,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === "/api/health") {
        return Response.json({ healthy: true, version: VERSION })
      }

      if (url.pathname === "/api/events" && request.method === "POST") {
        const body = await jsonBody(request)
        if (!isRecord(body) || typeof body["type"] !== "string") {
          return Response.json(
            { error: "event type required" },
            { status: 400 },
          )
        }
        const type = body["type"]
        if (!(hamiltonEventTypes as readonly string[]).includes(type)) {
          return Response.json(
            { error: `unknown event type: ${type}` },
            { status: 400 },
          )
        }
        const input: EmitInput = {
          type: type as EmitInput["type"],
          runId: optionalString(body, "runId") ?? defaultRunId,
          payload: body["payload"] ?? null,
        }
        const taskId = optionalString(body, "taskId")
        if (taskId) input.taskId = taskId
        const agentId = optionalString(body, "agentId")
        if (agentId) input.agentId = agentId
        const event = await bus.emit(input)
        return Response.json({ id: event.id, seq: event.seq })
      }

      if (url.pathname === "/api/events") {
        const runId = url.searchParams.get("run") ?? defaultRunId
        const n = Number(url.searchParams.get("n") ?? 50)
        const tail = await bus.tail(runId, Number.isFinite(n) ? n : 50)
        return Response.json(tail)
      }

      if (url.pathname === "/api/state") {
        const runId = url.searchParams.get("run") ?? defaultRunId
        const snapshot = await brain.readRunState(runId)
        const tail = await bus.tail(runId, 20)
        return Response.json({ snapshot, tail })
      }

      if (url.pathname === "/api/stream") {
        const encoder = new TextEncoder()
        let ping: ReturnType<typeof setInterval> | undefined
        let listener: ((event: HamiltonEvent) => void) | undefined
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            listener = (event: HamiltonEvent): void => {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              )
            }
            listeners.add(listener)
            ping = setInterval(() => {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ type: "ping" })}\n\n`),
              )
            }, PING_INTERVAL_MS)
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "connected" })}\n\n`,
              ),
            )
          },
          cancel() {
            if (listener) listeners.delete(listener)
            if (ping) clearInterval(ping)
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }

      if (url.pathname === "/") {
        return new Response(statusPage(), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }

      return new Response("not found", { status: 404 })
    },
  })

  if (bridge) void bridge.start()
  const url = `http://localhost:${server.port}`
  logger.info("Core listening on {url} (run {runId}, persist {persistDir})", {
    url,
    runId: defaultRunId,
    persistDir,
  })
  return {
    url,
    brain,
    emit: (input) => bus.emit(input),
    async stop(): Promise<void> {
      logger.info("Core stopping")
      bridge?.stop()
      server.stop(true)
      await brain.dispose()
    },
  }
}
