// Hamilton Core — the Bun executor (HAMILTON.md §3).
// M2: the autonomous-execution loop — dispatcher (worktrees/sessions/merges),
// worktree watcher (event-based git status), permission responder, live graph.

import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"
import { hamiltonEventTypes } from "@hamilton/shared"
import type { HamiltonEvent } from "@hamilton/shared"

import { createBridge } from "./bridge.ts"
import { loadConfigFile, resolveConfig } from "./config.ts"
import { createDispatcher, createPermissionResponder } from "./dispatch.ts"
import type { TaskSessionSpec } from "./dispatch.ts"
import { createBus } from "./eventbus.ts"
import type { EmitInput } from "./eventbus.ts"
import { createControlPlane } from "./opencode.ts"
import { createBrain } from "./runtime.ts"
import { statusPage } from "./status-page.ts"
import { createWorktreeWatcher } from "./worktrees.ts"
import { worktreeSection } from "./tree-graph.ts"
import type { BranchState } from "./tree-graph.ts"
import type { HamiltonConfig } from "@hamilton/shared"

export * from "./bridge.ts"
export * from "./config.ts"
export * from "./constants.ts"
export * from "./dispatch.ts"
export * from "./eventbus.ts"
export * from "./git.ts"
export * from "./opencode.ts"
export * from "./planner.ts"
export * from "./runtime.ts"
export * from "./status-page.ts"
export * from "./tree-graph.ts"
export * from "./worktrees.ts"
export type {
  Task,
  TaskGraph,
  CoreAction,
  CoreActionResult,
} from "@hamilton/shared"

export interface CoreOptions {
  port?: number
  /** Miniflare persist dir for KV/R2/DO state (inside the repo; default ".mf"). */
  persistDir?: string
  /** Default run id stamped on events without one (default "local-run"). */
  runId?: string
  /** baseUrl of a running `opencode serve` — starts the SSE bridge when set. */
  opencodeUrl?: string
  /** Hamilton runtime config overrides (defaults apply; see shared schema). */
  config?: Partial<HamiltonConfig>
  /** Repo the conductor provisions worktrees in (default: process.cwd()). */
  repoRoot?: string
  /** Parent branch task branches are created off (default: main). */
  parent?: string
  /** Resolves a task's session spec for dispatch (brief generation etc.). */
  getTask?: (
    taskId: string,
    worktreePath?: string,
  ) => TaskSessionSpec | undefined
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
  // Resolution: defaults < hamilton.config.ts (cwd) < explicit overrides.
  const fileConfig =
    options.config === undefined
      ? await loadConfigFile(process.cwd())
      : undefined
  const config = resolveConfig({
    ...fileConfig?.config,
    ...options.config,
  })
  if (fileConfig !== undefined) {
    logger.info("Config source: {source}{file}", {
      source: fileConfig.source,
      file: fileConfig.file ?? "",
    })
  }

  const brain = await createBrain({ persistDir, config })
  const bus = createBus({ brain, runId: defaultRunId })

  const listeners = new Set<(event: HamiltonEvent) => void>()
  bus.subscribe((event) => {
    for (const listener of listeners) listener(event)
  })

  const opencodeUrl = options.opencodeUrl ?? process.env.HAMILTON_OPCODE_URL
  const controlPlane = opencodeUrl
    ? createControlPlane({ baseUrl: opencodeUrl })
    : undefined
  const bridge = opencodeUrl
    ? createBridge({ baseUrl: opencodeUrl, runId: defaultRunId }, (event) => {
        void bus.emit(event)
      })
    : undefined

  // M2: the conductor's hands — dispatcher (worktree/session/merge actions),
  // the worktree watcher (event-based git status), and the permission
  // auto-responder. The brain decides; the Core executes; both over the bus.
  const repoRoot = options.repoRoot ?? process.cwd()
  const parent = options.parent ?? process.env.HAMILTON_PARENT_BRANCH ?? "main"
  const dispatcher = createDispatcher({
    runId: defaultRunId,
    repoRoot,
    worktreesDir: config.worktreesDir,
    parent,
    config,
    bus,
    brain,
    controlPlane,
    getTask: options.getTask,
  })
  brain.setCoreHandler(async (request) => {
    const action = (await jsonBody(
      request,
    )) as import("@hamilton/shared").CoreAction
    const result = await dispatcher.handleAction(action)
    return Response.json(result)
  })

  const watcher = createWorktreeWatcher(
    { options: { repoRoot, worktreesDir: config.worktreesDir } },
    (event) => {
      void bus.emit({
        type: "worktree.status_changed",
        runId: defaultRunId,
        payload: event,
      })
    },
  )
  watcher.start()
  bus.subscribe((event) => {
    if (event.type === "worktree.created" && isRecord(event.payload)) {
      const branch = optionalString(event.payload, "branch")
      const eventParent = optionalString(event.payload, "parent")
      if (branch && eventParent) watcher.trackBranch(branch, eventParent)
    }
    if (event.type === "worktree.removed" && isRecord(event.payload)) {
      const branch = optionalString(event.payload, "branch")
      if (branch) watcher.untrackBranch(branch)
    }
  })

  // Reviewer sessions get the read-only "reviewer" permission policy; every
  // other session (implementers) gets the implementer policy. The set is fed
  // from review.assigned events (mock and real sessions alike).
  const reviewerSessions = new Set<string>()
  bus.subscribe((event) => {
    if (event.type === "review.assigned" && isRecord(event.payload)) {
      const reviewers = event.payload["reviewers"]
      if (Array.isArray(reviewers)) {
        for (const reviewer of reviewers) {
          if (isRecord(reviewer) && typeof reviewer["sessionId"] === "string") {
            reviewerSessions.add(reviewer["sessionId"])
          }
        }
      }
    }
  })
  const responder = createPermissionResponder({
    controlPlane,
    roleForSession: (sessionId) =>
      reviewerSessions.has(sessionId) ? "reviewer" : "implementer",
  })
  bus.subscribe((event) => {
    void responder.handleTelemetry(event)
  })

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

      if (url.pathname === "/api/worktrees") {
        const runId = url.searchParams.get("run") ?? defaultRunId
        const raw = await brain.readRunState(runId)
        const branches = isRecord(raw)
          ? Array.isArray(raw["branches"])
            ? (raw["branches"] as BranchState[])
            : []
          : []
        return Response.json({
          html: worktreeSection(branches),
          count: branches.length,
        })
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
      watcher.stop()
      server.stop(true)
      await brain.dispose()
    },
  }
}
