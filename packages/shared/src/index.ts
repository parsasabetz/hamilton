import { z } from "zod"

// HAMILTON.md §4.2 — the canonical event envelope.

export interface HamiltonEvent {
  id: string
  type: EventType
  ts: string
  runId: string
  taskId?: string
  agentId?: string
  seq: number
  payload: unknown
}

// HAMILTON.md §4.3 — the full event type table (runtime array + derived type,
// so validators and the Core's /api/events endpoint share one source).

export const hamiltonEventTypes = [
  // agent domain
  "agent.claimed",
  "agent.started",
  "agent.milestone",
  "agent.heartbeat",
  "agent.error",
  "agent.blocked",
  "agent.ready_for_review",
  "agent.subagent_spawned",
  "agent.subagent_result",
  "agent.died",
  // agent domain — bridge-derived liveness (from the OpenCode SSE stream)
  "agent.stalled",
  "agent.idle",
  // agent domain — derived supervision (from tool-call telemetry)
  "agent.command",
  "agent.zone_violation",
  // review domain
  "review.assigned",
  "review.started",
  "review.submitted",
  "review.verdict",
  // task domain
  "task.dispatched",
  "task.status_changed",
  "task.merged",
  "task.escalated",
  "task.blocked",
  // run domain
  "run.planned",
  "run.pause",
  "run.resume",
  "run.finish",
  // telemetry domain — raw OpenCode stream passthrough (bridge)
  "telemetry.opencode",
  "telemetry.stream_lost",
  "telemetry.stream_reconnected",
  // system domain
  "budget.exceeded",
  "owner.action",
  "system.error",
] as const

export type EventType = (typeof hamiltonEventTypes)[number]

// HAMILTON.md §9.1 — the authoritative task schema.

export const taskStatusSchema = z.enum([
  "planned",
  "in-progress",
  "ready-for-review",
  "reviewing",
  "approved",
  "merged",
  "blocked",
  "optional",
])

export type TaskStatus = z.infer<typeof taskStatusSchema>

export const onFailureSchema = z.enum(["retry-once", "skip", "escalate"])

export const roleSchema = z.enum(["implementer", "planner", "reviewer", "docs"])

export const taskSchema = z.object({
  id: z.string(),
  role: roleSchema,
  zone: z.array(z.string()),
  depends_on: z.array(z.string()),
  status: taskStatusSchema,
  on_failure: onFailureSchema,
  contract: z.object({
    inputs: z.array(z.string()),
    outputs: z.array(z.string()),
  }),
  model: z.string(),
  allowed_subagents: z.array(z.string()).default([]),
  budget_cap: z.number().optional(),
  branch: z.string().optional(),
  pr_title: z.string().optional(),
})

export type Task = z.infer<typeof taskSchema>

// HAMILTON.md §"Runtime config" — the constants layer's runtime configuration.
// Validated once in the Core; the brain receives it as a JSON binding.

export const hamiltonConfigSchema = z.object({
  /** Bash command prefixes to record as agent.command (e.g. ["git"]). */
  watchCommands: z.array(z.string()).default(["git"]),
  /** Zone-violation policy: record | warn | block (block wired in M2). */
  zoneViolation: z.enum(["record", "warn", "block"]).default("record"),
  /** Early-stop policy: when enough agents fail, halt dispatch after healthy
   *  agents finish (whichever threshold trips first). */
  earlyStop: z
    .object({
      enabled: z.boolean(),
      maxFailedAgents: z.number().int().positive(),
      failedRatio: z.number().min(0).max(1),
    })
    .default({ enabled: true, maxFailedAgents: 2, failedRatio: 0.5 }),
  /** Queue event delivery: retry with exponential backoff, capped. */
  eventRetry: z
    .object({
      maxAttempts: z.number().int().positive(),
      baseDelayMs: z.number().int().positive(),
      maxDelayMs: z.number().int().positive(),
    })
    .default({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 }),
  /** Lease TTL for in-flight event processing (double-delivery guard). */
  leaseTtlMs: z.number().int().positive().default(60_000),
})

export type HamiltonConfig = z.infer<typeof hamiltonConfigSchema>

export const defaultHamiltonConfig: HamiltonConfig = hamiltonConfigSchema.parse(
  {},
)

// HAMILTON.md §7 — the agent-facing MCP tool surface.

export const hamiltonToolNames = [
  "heartbeat",
  "checkpoint",
  "emit_event",
  "ask_question",
  "report_subagent",
  "ready_for_review",
] as const

export type HamiltonToolName = (typeof hamiltonToolNames)[number]

export interface HamiltonToolSpec {
  name: HamiltonToolName
  description: string
  inputSchema: z.ZodTypeAny
}

export const hamiltonToolSpecs: HamiltonToolSpec[] = [
  {
    name: "heartbeat",
    description:
      "Report liveness to the orchestrator; resets the heartbeat-expiry alarm.",
    inputSchema: z.object({
      note: z.string().optional(),
    }),
  },
  {
    name: "checkpoint",
    description:
      "Emit an agent.milestone event and append a progress artifact.",
    inputSchema: z.object({
      phase: z
        .string()
        .describe("e.g. claimed | started | milestone | ready-for-review"),
      message: z.string(),
      files: z.array(z.string()).optional(),
    }),
  },
  {
    name: "emit_event",
    description: "Emit a custom agent-side event with a payload.",
    inputSchema: z.object({
      type: z.string(),
      payload: z.record(z.string(), z.unknown()),
    }),
  },
  {
    name: "ask_question",
    description:
      "Route a question to the owner board; non-blocking unless blocking: true.",
    inputSchema: z.object({
      question: z.string(),
      options: z.array(z.string()).optional(),
      blocking: z.boolean().optional().default(false),
    }),
  },
  {
    name: "report_subagent",
    description: "Report a spawned subagent: role, objective, and result.",
    inputSchema: z.object({
      role: z.string(),
      objective: z.string(),
      result: z.string(),
    }),
  },
  {
    name: "ready_for_review",
    description: "Declare the task ready for the three-phase gate.",
    inputSchema: z.object({
      summary: z.string(),
      prUrl: z.string().optional(),
      branch: z.string(),
      checks: z.record(z.string(), z.unknown()).optional(),
    }),
  },
]
