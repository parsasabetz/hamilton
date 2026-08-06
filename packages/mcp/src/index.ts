// Hamilton MCP server (HAMILTON.md §7) — stdio, built on @modelcontextprotocol/sdk.
// Tool registry from @hamilton/shared; handlers emit events onto the Core bus
// through the client.ts shim (M1). The conductor tools (start_run, run_status)
// call the Core HTTP surface directly through the same client.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  checkpointMatrixError,
  checkpointPhaseStatus,
  checkpointPhases,
  hamiltonToolSpecs,
  type CheckpointPhase,
  type CheckpointStatus,
  type EventType,
  type HamiltonToolName,
  type HamiltonToolSpec,
} from "@hamilton/shared"
import {
  createShim,
  getRunStatus,
  isEventType,
  postJson,
  type ShimHandle,
} from "./client.ts"

const VERSION = "0.0.0"

// LogTape is global per process; the Core and the MCP server configure the
// same ["hamilton", ...] loggers, and tests load both in one process. The
// guard shares the flag via a global Symbol (same mechanism as the Core).
const LOGGING_KEY = Symbol.for("hamilton.logging.configured")
const globalForLogging = globalThis as Record<PropertyKey, unknown>
if (globalForLogging[LOGGING_KEY] !== true) {
  globalForLogging[LOGGING_KEY] = true
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
}

const logger = getLogger(["hamilton", "mcp"])

export interface CheckpointArgs {
  phase: string
  status: string
  message: string
  files?: string[]
}

interface EmitEventArgs {
  type: string
  payload: Record<string, unknown>
}

interface AskQuestionArgs {
  question: string
  options?: string[]
  blocking: boolean
}

export interface ReportSubagentArgs {
  role: string
  objective: string
  result: string
}

interface ReadyForReviewArgs {
  summary: string
  prUrl?: string
  branch: string
  checks?: Record<string, unknown>
}

export interface SubmitReviewArgs {
  reviewer: string
  verdict: "pass" | "fail"
  findings?: Array<{
    id: string
    location: string
    issue: string
    suggested_fix?: string
  }>
  checksRun?: Array<{ name: string; ok: boolean }>
  testsWritten?: string[]
  summary?: string
}

interface StartRunArgs {
  planJson?: string
  prompt?: string
  mergeAuthority?: "autonomous" | "owner-gated"
}

interface RunStatusArgs {
  runId: string
}

// M3 — the review.submitted payload builder; findings default to [] (the zod
// spec's .default([]) carries through), everything else stays omitted when
// undefined.
export function submitReviewPayload(
  args: SubmitReviewArgs,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    reviewer: args.reviewer,
    verdict: args.verdict,
    findings: args.findings ?? [],
  }
  if (args.checksRun !== undefined) payload["checksRun"] = args.checksRun
  if (args.testsWritten !== undefined)
    payload["testsWritten"] = args.testsWritten
  if (args.summary !== undefined) payload["summary"] = args.summary
  return payload
}

// The phase field carries the domain meaning (HAMILTON.md §7): a checkpoint's
// phase selects the emitted event type; working/milestone record progress.
export function checkpointEventType(phase: string): EventType {
  if (phase === "claimed") return "agent.claimed"
  if (phase === "started") return "agent.started"
  if (phase === "ready-for-review") return "agent.ready_for_review"
  if (phase === "error") return "agent.error"
  if (phase === "blocked") return "agent.blocked"
  return "agent.milestone"
}

export function checkpointPayload(
  args: CheckpointArgs,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    phase: args.phase,
    status: args.status,
    message: args.message,
  }
  if (args.files !== undefined) payload["files"] = args.files
  return payload
}

// The SDK pre-validates against the schema, but the superRefine message may
// be reformatted in transit — so the handler re-checks the compatibility
// matrix explicitly and surfaces the byte-exact error text.
export function validateCheckpoint(
  args: CheckpointArgs,
): { ok: true } | { ok: false; error: string } {
  if (!(checkpointPhases as readonly string[]).includes(args.phase)) {
    return { ok: false, error: `unknown checkpoint phase: ${args.phase}` }
  }
  const allowed = checkpointPhaseStatus[args.phase as CheckpointPhase]
  if (
    allowed !== undefined &&
    !allowed.includes(args.status as CheckpointStatus)
  ) {
    return { ok: false, error: checkpointMatrixError(args.phase, args.status) }
  }
  return { ok: true }
}

// report_subagent emits two deterministic events: the spawn record first
// (mandatory per-brief protocol), then the result.
export function subagentEvents(
  args: ReportSubagentArgs,
): Array<{ type: EventType; payload: Record<string, unknown> }> {
  return [
    {
      type: "agent.subagent_spawned",
      payload: { role: args.role, objective: args.objective },
    },
    {
      type: "agent.subagent_result",
      payload: {
        role: args.role,
        objective: args.objective,
        result: args.result,
      },
    },
  ]
}

function toolSpec(name: HamiltonToolName): HamiltonToolSpec {
  const spec = hamiltonToolSpecs.find((candidate) => candidate.name === name)
  if (spec === undefined) {
    throw new Error(`missing tool spec for ${name}`)
  }
  return spec
}

async function emitAndRespond(
  shim: ShimHandle,
  toolName: string,
  eventType: EventType,
  payload: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await shim.emit(eventType, payload)
  logger.info("Emitted {name} ok={ok} eventId={eventId}", {
    name: toolName,
    ok: result.ok,
    eventId: result.eventId,
  })
  if (result.ok && result.eventId !== undefined) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[hamilton:${toolName}] emitted ${result.eventId} seq ${result.seq}`,
        },
      ],
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `[hamilton:${toolName}] emit failed: ${result.error ?? "unknown error"}`,
      },
    ],
    isError: true,
  }
}

// Dual-emission helper: the spawn record is mandatory, so a failed spawn is a
// hard error; a failed result still reports the spawn's status.
async function emitBoth(
  shim: ShimHandle,
  toolName: string,
  events: Array<{ type: EventType; payload: Record<string, unknown> }>,
): Promise<CallToolResult> {
  const spawnEvent = events[0]
  const resultEvent = events[1]
  if (spawnEvent === undefined || resultEvent === undefined) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[hamilton:${toolName}] requires spawn and result events`,
        },
      ],
      isError: true,
    }
  }
  const spawn = await shim.emit(spawnEvent.type, spawnEvent.payload)
  logger.info("Emitted {name} ok={ok} eventId={eventId} (spawn)", {
    name: toolName,
    ok: spawn.ok,
    eventId: spawn.eventId,
  })
  if (!spawn.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[hamilton:${toolName}] spawn emit failed: ${spawn.error ?? "unknown error"}`,
        },
      ],
      isError: true,
    }
  }
  const result = await shim.emit(resultEvent.type, resultEvent.payload)
  logger.info("Emitted {name} ok={ok} eventId={eventId} (result)", {
    name: toolName,
    ok: result.ok,
    eventId: result.eventId,
  })
  if (!result.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[hamilton:${toolName}] spawn ok (${spawn.eventId ?? "?"}) but result emit failed: ${result.error ?? "unknown error"}`,
        },
      ],
      isError: true,
    }
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `[hamilton:${toolName}] spawned ${spawn.eventId} seq ${spawn.seq}; result ${result.eventId} seq ${result.seq}`,
      },
    ],
  }
}

export function createMcpServer(): McpServer {
  const shim = createShim()
  const server = new McpServer({ name: "hamilton", version: VERSION })

  const checkpoint = toolSpec("checkpoint")
  server.registerTool(
    checkpoint.name,
    {
      title: checkpoint.name,
      description: checkpoint.description,
      inputSchema: checkpoint.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const checkpointArgs = args as CheckpointArgs
      const validation = validateCheckpoint(checkpointArgs)
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: validation.error }],
          isError: true,
        }
      }
      return emitAndRespond(
        shim,
        checkpoint.name,
        checkpointEventType(checkpointArgs.phase),
        checkpointPayload(checkpointArgs),
      )
    },
  )

  const emitEvent = toolSpec("emit_event")
  server.registerTool(
    emitEvent.name,
    {
      title: emitEvent.name,
      description: emitEvent.description,
      inputSchema: emitEvent.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { type, payload } = args as EmitEventArgs
      if (!isEventType(type)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `[hamilton:${emitEvent.name}] unknown event type: ${type}`,
            },
          ],
          isError: true,
        }
      }
      return emitAndRespond(shim, emitEvent.name, type, payload)
    },
  )

  const askQuestion = toolSpec("ask_question")
  server.registerTool(
    askQuestion.name,
    {
      title: askQuestion.name,
      description: askQuestion.description,
      inputSchema: askQuestion.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { question, options, blocking } = args as AskQuestionArgs
      const payload: Record<string, unknown> = { question, blocking }
      if (options !== undefined) payload["options"] = options
      return emitAndRespond(shim, askQuestion.name, "agent.blocked", payload)
    },
  )

  const reportSubagent = toolSpec("report_subagent")
  server.registerTool(
    reportSubagent.name,
    {
      title: reportSubagent.name,
      description: reportSubagent.description,
      inputSchema: reportSubagent.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      return emitBoth(
        shim,
        reportSubagent.name,
        subagentEvents(args as ReportSubagentArgs),
      )
    },
  )

  const readyForReview = toolSpec("ready_for_review")
  server.registerTool(
    readyForReview.name,
    {
      title: readyForReview.name,
      description: readyForReview.description,
      inputSchema: readyForReview.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { summary, prUrl, branch, checks } = args as ReadyForReviewArgs
      const payload: Record<string, unknown> = { summary, branch }
      if (prUrl !== undefined) payload["prUrl"] = prUrl
      if (checks !== undefined) payload["checks"] = checks
      return emitAndRespond(
        shim,
        readyForReview.name,
        "agent.ready_for_review",
        payload,
      )
    },
  )

  const submitReview = toolSpec("submit_review")
  server.registerTool(
    submitReview.name,
    {
      title: submitReview.name,
      description: submitReview.description,
      inputSchema: submitReview.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const review = args as SubmitReviewArgs
      return emitAndRespond(
        shim,
        submitReview.name,
        "review.submitted",
        submitReviewPayload(review),
      )
    },
  )

  const startRun = toolSpec("start_run")
  server.registerTool(
    startRun.name,
    {
      title: startRun.name,
      description: startRun.description,
      inputSchema: startRun.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { planJson, prompt, mergeAuthority } = args as StartRunArgs
      const body: Record<string, unknown> = {}
      if (planJson !== undefined) body["planJson"] = planJson
      if (prompt !== undefined) body["prompt"] = prompt
      if (mergeAuthority !== undefined) body["mergeAuthority"] = mergeAuthority
      const result = await postJson(shim.coreUrl, "/api/run", body)
      const data = result.data
      const runId =
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)["runId"]
          : undefined
      if (result.ok && typeof runId === "string") {
        return {
          content: [
            {
              type: "text" as const,
              text: `[hamilton:start_run] run started: ${runId}`,
            },
          ],
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `[hamilton:start_run] failed: ${result.error ?? "unexpected core response"}`,
          },
        ],
        isError: true,
      }
    },
  )

  const runStatus = toolSpec("run_status")
  server.registerTool(
    runStatus.name,
    {
      title: runStatus.name,
      description: runStatus.description,
      inputSchema: runStatus.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { runId } = args as RunStatusArgs
      const result = await getRunStatus(shim.coreUrl, runId)
      if (result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result.data, null, 2),
            },
          ],
        }
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `[hamilton:run_status] failed: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      }
    },
  )

  return server
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.main) {
  await runStdioServer()
}
