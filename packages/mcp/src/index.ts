// Hamilton MCP server (HAMILTON.md §7) — stdio, built on @modelcontextprotocol/sdk.
// Tool registry from @hamilton/shared; handlers emit events onto the Core bus
// through the client.ts shim (M1).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import {
  hamiltonToolSpecs,
  type EventType,
  type HamiltonToolName,
  type HamiltonToolSpec,
} from "@hamilton/shared"
import { createShim, isEventType, type ShimHandle } from "./client.ts"

const VERSION = "0.0.0"

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

const logger = getLogger(["hamilton", "mcp"])

interface HeartbeatArgs {
  note?: string
}

interface CheckpointArgs {
  phase: string
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

interface ReportSubagentArgs {
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

export function createMcpServer(): McpServer {
  const shim = createShim()
  const server = new McpServer({ name: "hamilton", version: VERSION })

  const heartbeat = toolSpec("heartbeat")
  server.registerTool(
    heartbeat.name,
    {
      title: heartbeat.name,
      description: heartbeat.description,
      inputSchema: heartbeat.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { note } = args as HeartbeatArgs
      const payload: Record<string, unknown> = {}
      if (note !== undefined) payload["note"] = note
      return emitAndRespond(shim, heartbeat.name, "agent.heartbeat", payload)
    },
  )

  const checkpoint = toolSpec("checkpoint")
  server.registerTool(
    checkpoint.name,
    {
      title: checkpoint.name,
      description: checkpoint.description,
      inputSchema: checkpoint.inputSchema,
    },
    async (args: unknown): Promise<CallToolResult> => {
      const { phase, message, files } = args as CheckpointArgs
      const payload: Record<string, unknown> = { phase, message }
      if (files !== undefined) payload["files"] = files
      // The phase field carries the domain meaning (HAMILTON.md §7): a
      // checkpoint's phase selects the emitted event type.
      const eventType =
        phase === "claimed"
          ? "agent.claimed"
          : phase === "started"
            ? "agent.started"
            : phase === "ready-for-review"
              ? "agent.ready_for_review"
              : "agent.milestone"
      return emitAndRespond(shim, checkpoint.name, eventType, payload)
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
      const { role, objective, result } = args as ReportSubagentArgs
      return emitAndRespond(
        shim,
        reportSubagent.name,
        "agent.subagent_result",
        {
          role,
          objective,
          result,
        },
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
