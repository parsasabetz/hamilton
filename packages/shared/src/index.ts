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
  // worktree domain — conductor-owned git status (worktree watcher)
  "worktree.created",
  "worktree.status_changed",
  "worktree.removed",
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

// HAMILTON.md §9 — the task graph (a run's full plan).

export const taskGraphSchema = z.object({
  tasks: z.array(taskSchema).min(1),
  meta: z
    .object({
      prompt: z.string().optional(),
      created_at: z.string().optional(),
    })
    .optional(),
})

export type TaskGraph = z.infer<typeof taskGraphSchema>

// HAMILTON.md §"Dispatch loop" — the RunDO → Core action protocol (carried
// over the miniflare CORE service binding; plain JSON, no zod in the bundle).

export type CoreAction =
  | {
      action: "worktree.ensure"
      runId: string
      taskId: string
      parent: string
      branch: string
    }
  | {
      action: "session.start"
      runId: string
      taskId: string
      agent: string
      model: string
      brief: string
    }
  | {
      action: "session.abort"
      runId: string
      taskId: string
    }
  | {
      action: "session.nudge"
      runId: string
      taskId: string
      message: string
    }
  | {
      action: "review.start"
      runId: string
      taskId: string
      branch: string
      parent: string
      roles: string[]
      model?: string
      /** Task zone — the dispatcher's deterministic READ checks diff paths. */
      zone: string[]
      /** Task contract — reviewers judge against the objective. */
      contract?: { inputs: string[]; outputs: string[] }
    }
  | {
      action: "review.cleanup"
      runId: string
      taskId: string
    }
  | {
      action: "merge.execute"
      runId: string
      taskId: string
      branch: string
      parent: string
    }
  | {
      action: "pr.verify"
      runId: string
      taskId: string
      branch: string
      parent: string
    }

export type CoreActionResult =
  | {
      ok: true
      worktreePath?: string
      sessionId?: string
      mergeCommit?: string
      reviewerSessionIds?: string[]
      reviewWorktreePath?: string
      prVerification?: {
        verified: boolean
        prUrl?: string
        base?: string
        reason?: string
      }
    }
  | { ok: false; error: string }

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
  /** Worktree provisioning (M2): relative dir for task worktrees + installs. */
  worktreesDir: z.string().default(".worktrees"),
  provision: z
    .object({
      /** "auto" installs in new worktrees when a lockfile exists; "skip" never. */
      install: z.enum(["auto", "skip"]),
    })
    .default({ install: "auto" }),
  /** Composite activity window (M2): an agent is "active" when any signal —
   *  git changes, commits, OpenCode tool calls, telemetry — arrived within
   *  windowMs. Silence past the window = idle; past the bridge stall timeout
   *  = stalled. */
  activity: z
    .object({
      windowMs: z.number().int().positive(),
    })
    .default({ windowMs: 120_000 }),
  /** Merge authority: "autonomous" executes merges on ready_for_review;
   *  "owner-gated" waits for the owner (D2 default; M2 demo passes autonomous). */
  mergeAuthority: z.enum(["autonomous", "owner-gated"]).default("owner-gated"),
  /** Review gate (M3): reviewer roles, veto weights, retry cap. */
  review: z
    .object({
      /** Reviewer roles dispatched per gate (one session each), e.g.
       *  ["correctness", "standards", "security"]. */
      roles: z.array(z.string()),
      /** Roles whose "fail" verdict vetoes the merge. ["*"] = every role
       *  vetoes (fail-closed, the default); a non-vetoed role's findings
       *  still route back to the agent as notes. */
      vetoRoles: z.array(z.string()),
      /** Rejections before the task is blocked + escalated. */
      maxRetries: z.number().int().positive(),
      /** Model for reviewer sessions (default: the task's model). */
      model: z.string().optional(),
    })
    .default({
      roles: ["correctness", "standards"],
      vetoRoles: ["*"],
      maxRetries: 2,
    }),
  /** Parent branch the conductor assigns to all task branches (rule: agents
   *  may only target it). Precedence: run.planned payload > HAMILTON_PARENT_BRANCH
   *  env > this config > "main". */
  parentBranch: z.string().default("main"),
  /** Protocol enforcement: when true, ready-for-review tasks with hard
   *  protocol violations (no claim, no start) fail the gate deterministically. */
  protocol: z
    .object({
      blockOnViolation: z.boolean(),
    })
    .default({ blockOnViolation: false }),
})

export type HamiltonConfig = z.infer<typeof hamiltonConfigSchema>

export const defaultHamiltonConfig: HamiltonConfig = hamiltonConfigSchema.parse(
  {},
)

// HAMILTON.md §7 — the agent-facing MCP tool surface.
// One responsibility per tool; validation errors are actionable.

export const hamiltonToolNames = [
  "checkpoint",
  "emit_event",
  "ask_question",
  "report_subagent",
  "ready_for_review",
  "submit_review",
  "start_run",
  "run_status",
] as const

export type HamiltonToolName = (typeof hamiltonToolNames)[number]

// Checkpoint phases — the official reporting vocabulary. Each phase maps to a
// deterministic event; `status` is the agent's self-assessment, constrained by
// the phase compatibility matrix below.

export const checkpointPhases = [
  "claimed",
  "started",
  "working",
  "milestone",
  "error",
  "blocked",
  "ready-for-review",
] as const

export type CheckpointPhase = (typeof checkpointPhases)[number]

export const checkpointStatuses = ["working", "blocked", "complete"] as const

export type CheckpointStatus = (typeof checkpointStatuses)[number]

/** phase → allowed statuses (the compatibility matrix). */
export const checkpointPhaseStatus: Record<
  CheckpointPhase,
  readonly CheckpointStatus[]
> = {
  claimed: ["working"],
  started: ["working"],
  working: ["working"],
  milestone: ["working"],
  error: ["blocked"],
  blocked: ["blocked"],
  "ready-for-review": ["complete"],
}

/** Actionable, generated-from-the-matrix error for a bad phase/status combo. */
export function checkpointMatrixError(phase: string, status: string): string {
  const required = checkpointPhaseStatus[phase as CheckpointPhase]
  const allowed = Object.entries(checkpointPhaseStatus)
    .map(
      ([allowedPhase, statuses]) => `${allowedPhase} → ${statuses.join(", ")}`,
    )
    .join("\n")
  return [
    "Invalid checkpoint combination:",
    `phase="${phase}" requires status="${required?.[0] ?? "?"}"`,
    `received status="${status}"`,
    "",
    "Allowed:",
    allowed,
  ].join("\n")
}

export interface HamiltonToolSpec {
  name: HamiltonToolName
  description: string
  inputSchema: z.ZodTypeAny
}

export const hamiltonToolSpecs: HamiltonToolSpec[] = [
  {
    name: "checkpoint",
    description:
      "Report what you are doing. phase selects the event (claimed/started/error/blocked/ready-for-review map to their events; working/milestone record progress); status is your self-assessment and must match the phase (see the compatibility matrix in your guidelines). Invalid combinations error with the allowed matrix.",
    inputSchema: z
      .object({
        phase: z.enum(checkpointPhases),
        status: z.enum(checkpointStatuses),
        message: z.string().min(1).describe("What you are doing right now"),
        files: z.array(z.string()).optional(),
      })
      .superRefine((value, ctx) => {
        const allowed = checkpointPhaseStatus[value.phase]
        if (allowed !== undefined && !allowed.includes(value.status)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: checkpointMatrixError(value.phase, value.status),
          })
        }
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
    description:
      "Report a spawned subagent: role, objective, and result. Emits both the spawn and the result deterministically.",
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
  {
    name: "submit_review",
    description:
      "File a structured review: role, verdict, and findings (id, location, issue, suggested fix). Reviewer outputs are immutable — a changed mind files Review #2.",
    inputSchema: z.object({
      reviewer: z
        .string()
        .describe("Reviewer role assigned by the orchestrator"),
      verdict: z.enum(["pass", "fail"]),
      findings: z
        .array(
          z.object({
            id: z.string().describe("Finding id, e.g. SEC-001"),
            location: z.string().describe("File:line, e.g. api/login.ts:42"),
            issue: z.string(),
            suggested_fix: z.string().optional(),
          }),
        )
        .default([]),
      checksRun: z
        .array(z.object({ name: z.string(), ok: z.boolean() }))
        .optional(),
      testsWritten: z.array(z.string()).optional(),
      summary: z.string().optional(),
    }),
  },
  {
    name: "start_run",
    description:
      "Start an autonomous run (conductor-only — assistants must never call this). Accepts a minimal plan: the planner validates it and expands defaults (branch, status, model, pr_title). Exactly one of planJson (a task-graph JSON) or prompt (decomposed by the planner) is required.",
    inputSchema: z
      .object({
        planJson: z
          .string()
          .optional()
          .describe("Task-graph JSON (zod-validated; defaults expanded)"),
        prompt: z
          .string()
          .optional()
          .describe("Request the planner decomposes"),
        mergeAuthority: z.enum(["autonomous", "owner-gated"]).optional(),
      })
      .superRefine((value, ctx) => {
        if (value.planJson === undefined && value.prompt === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'start_run requires exactly one of "planJson" or "prompt"',
          })
        }
        if (value.planJson !== undefined && value.prompt !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'start_run accepts "planJson" OR "prompt", not both',
          })
        }
      }),
  },
  {
    name: "run_status",
    description:
      "Summarize a run's state. Read-only: MUST NOT compute, mutate, trigger, or repair — ONLY summarize. Returns the RunStatusSummary DTO (phase, progress, agents with doing/activity, tasks, violations).",
    inputSchema: z.object({
      runId: z.string(),
    }),
  },
]

// M3 — the review contract (structured findings; verdicts derive from them).

export interface ReviewFinding {
  id: string
  location: string
  issue: string
  suggested_fix?: string
}

export interface ReviewSubmission {
  /** Reviewer role (from config review.roles), e.g. "security". */
  reviewer: string
  /** Session index within the review batch. */
  idx: number
  verdict: "pass" | "fail"
  findings: ReviewFinding[]
  checksRun?: Array<{ name: string; ok: boolean }>
  testsWritten?: string[]
  summary?: string
}

// run_status DTO — a dedicated summary contract so the tool never depends on
// raw run-state internals (they can evolve freely).

export interface RunStatusAgent {
  agentId: string
  taskId?: string
  state: string
  doing?: {
    phase?: string
    status?: string
    message?: string
  }
  activityAgeMs?: number
  protocol?: {
    claimed: boolean
    started: boolean
    errors: number
    subagents: number
    ready: boolean
  }
}

export interface RunStatusTask {
  id: string
  status: string
  role: string
  branch?: string
  reviewRetries?: number
}

export interface RunStatusViolation {
  taskId?: string
  agentId?: string
  kind: string
  detail: string
}

export interface RunStatusSummary {
  runId: string
  phase: string
  seq: number
  updatedAt?: string
  progress: {
    planned: number
    inProgress: number
    reviewing: number
    approved: number
    merged: number
    blocked: number
  }
  agents: RunStatusAgent[]
  tasks: RunStatusTask[]
  violations: RunStatusViolation[]
}
