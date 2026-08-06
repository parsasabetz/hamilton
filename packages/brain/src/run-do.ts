// Hamilton Brain — RunDO: per-run orchestrator state machine (HAMILTON.md §5).
//
// KV layout:
//   REGISTRY:
//     state:${runId}:run               — run snapshot { runId, phase, seq, updatedAt, tasks[], agents[], branches[], parent }
//     state:${runId}:agent:${agentId}  — agent snapshot, written by AgentDO on liveness expiry
//     dedupe:${eventId}                — event dedupe marker (expirationTtl 86400)
//     lease:${eventId}                 — queue delivery lease (double-delivery guard)
//     dead:${eventId}                  — give-up record after queue retries are exhausted
//   ARTIFACTS:
//     artifacts:${runId}/agent-${agentId}/${kind}/${seq}-${eventId}.json — per-agent append logs
//   EVENTS (owned by the Core bus, NOT by brain — do not touch):
//     evt:${runId}:${seq}              — event log
//     seq:${runId}:counter             — next sequence number

import type {
  CoreAction,
  CoreActionResult,
  HamiltonConfig,
  HamiltonEvent,
  ReviewFinding,
  ReviewSubmission,
  Task,
  TaskStatus,
} from "@hamilton/shared"
import { DurableObject } from "cloudflare:workers"

import { parseConfig } from "./index.ts"
import type { Env } from "./index.ts"

const KEYS = {
  graph: "graph",
  tasks: "tasks",
  agents: "agents",
  phase: "phase",
  branches: "branches",
  parent: "parent",
  lastSeq: "lastSeq",
  lastEventId: "lastEventId",
} as const

const DEDUPE_TTL_SECONDS = 86_400
const ISSUED_TTL_SECONDS = 86_400

// M3 — one reviewer session within a gate round (review.assigned/submitted).
export interface ReviewerEntry {
  idx: number
  role: string
  sessionId?: string
  verdict?: "pass" | "fail"
  submittedAt?: string
  /** Findings from this reviewer's submission(s), used to rebuild the
   *  ReviewSubmission list for decideGate once every reviewer has voted. */
  findings?: ReviewFinding[]
}

export interface TaskRunState {
  id: string
  status: TaskStatus
  role: string
  branch?: string
  zone: string[]
  dependsOn?: string[]
  contract?: { inputs: string[]; outputs: string[] }
  lastEventType?: string
  lastEventAt?: string
  /** M3 gate state (see review.* events). */
  reviewers?: ReviewerEntry[]
  /** Rejection count — a gate round's fail verdicts; maxRetries blocks. */
  reviewRetries?: number
  /** Review worktree (review.assigned worktreePath) — cleaned up once the
   *  task leaves the gate (approved/blocked). */
  reviewWorktreePath?: string
  /** All findings accumulated across reviewers since the last fresh gate. */
  reviewFindings?: ReviewFinding[]
  /** pr.verify result — informational PR verification shown to reviewers;
   *  stored once from the pr.verify CoreActionResult. Gates nothing. */
  prVerification?: PrVerification
}

export interface PrVerification {
  verified: boolean
  prUrl?: string
  base?: string
  reason?: string
}

export interface AgentRunState {
  agentId: string
  taskId?: string
  state: string
  heartbeatAt?: string
  lastActivityAt?: string
  busy?: boolean
  stalledAt?: string
  diedAt?: string
  failures: number
  lastCommand?: string
  zoneViolations: number
  milestoneCount: number
  /** Last reported self-assessment (checkpoint status). */
  status?: "working" | "blocked" | "complete"
  lastPhase?: string
  lastReportAt?: string
  lastMessage?: string
  lastFiles?: string[]
  claimedAt?: string
  startedAt?: string
  errorCount?: number
  subagentCount?: number
  lastSubagentRole?: string
  lastReadyAt?: string
}

// Conductor-owned git state for one worktree branch (worktree.* events).
export interface BranchRunState {
  branch: string
  parent: string
  worktreePath?: string
  ahead?: number
  behind?: number
  dirtyCount?: number
  unpushedCount?: number
  commitCount?: number
  merged?: boolean
  lastEventAt?: string
  status?: string
}

export interface RunSnapshot {
  runId?: string
  tasks: Record<string, TaskRunState>
  agents: Record<string, AgentRunState>
  phase: string
  parent?: string
  branches?: Record<string, BranchRunState>
}

export type AgentActivity = "active" | "idle" | "stalled"

const TASK_STATUSES: readonly TaskStatus[] = [
  "planned",
  "in-progress",
  "ready-for-review",
  "reviewing",
  "approved",
  "merged",
  "blocked",
  "optional",
]

const TASK_STATUS_SET = new Set<string>(TASK_STATUSES)

const ROLES = ["implementer", "planner", "reviewer", "docs"] as const

const ON_FAILURES = ["retry-once", "skip", "escalate"] as const

export function parseTaskStatus(value: unknown): TaskStatus | undefined {
  if (typeof value !== "string") return undefined
  return TASK_STATUS_SET.has(value) ? (value as TaskStatus) : undefined
}

export function isHamiltonEvent(value: unknown): value is HamiltonEvent {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.type === "string" &&
    typeof v.ts === "string" &&
    typeof v.runId === "string" &&
    typeof v.seq === "number"
  )
}

export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await request.text())
  } catch {
    return undefined
  }
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    if (typeof item !== "string") return undefined
  }
  return value
}

// Reported fields from a checkpoint payload ({ phase, status, message, files })
// for the agent's protocol bookkeeping. Every checkpoint-mapped event stores
// these defensively — old sessions may omit any of them; only what is present
// lands in the row, and lastReportAt always reflects the event itself.
function checkpointReported(
  payload: Record<string, unknown>,
  ts: string,
): Partial<AgentRunState> {
  const patch: Partial<AgentRunState> = { lastReportAt: ts }
  const status = payload.status
  if (status === "working" || status === "blocked" || status === "complete") {
    patch.status = status
  }
  if (typeof payload.phase === "string") patch.lastPhase = payload.phase
  const message = payload.message
  if (typeof message === "string") patch.lastMessage = message.slice(0, 200)
  const files = stringArray(payload.files)
  if (files !== undefined) patch.lastFiles = files
  return patch
}

// Telemetry-derived supervision — pure extracts over a telemetry.opencode
// payload ({ eventId?, opencodeType, sessionId?, properties }), so the RunDO
// wiring stays thin and the logic is unit-testable.

export function extractBashCommand(
  payload: unknown,
  watchCommands: readonly string[],
): { command: string; matched: string | null } | null {
  const record = payloadRecord(payload)
  if (record.opencodeType !== "session.next.tool.called") return null
  const properties = record.properties
  if (typeof properties !== "object" || properties === null) return null
  const props = properties as Record<string, unknown>
  if (props.tool !== "bash") return null
  const input = props.input
  if (typeof input !== "object" || input === null) return null
  const command = (input as Record<string, unknown>).command
  if (typeof command !== "string" || command.length === 0) return null
  const matched = watchCommands.find((prefix) => command.startsWith(prefix))
  return { command, matched: matched ?? null }
}

export function findZoneViolation(
  payload: unknown,
  zone: readonly string[],
): string | null {
  const record = payloadRecord(payload)
  if (record.opencodeType !== "session.next.tool.called") return null
  const properties = record.properties
  if (typeof properties !== "object" || properties === null) return null
  const props = properties as Record<string, unknown>
  if (props.tool !== "edit" && props.tool !== "write") return null
  const input = props.input
  if (typeof input !== "object" || input === null) return null
  const filePath = (input as Record<string, unknown>).filePath
  if (typeof filePath !== "string" || filePath.length === 0) return null
  if (zone.length === 0) return null
  if (zone.some((prefix) => filePath.startsWith(prefix))) return null
  return filePath
}

export function recordCommand(
  snapshot: RunSnapshot,
  agentId: string,
  command: string,
  matched: string | null,
): RunSnapshot {
  let next = patchAgent(snapshot, agentId, { lastCommand: command })
  if (matched !== null) {
    const taskId = next.agents[agentId]?.taskId
    if (taskId !== undefined && next.tasks[taskId] !== undefined) {
      next = patchTask(next, taskId, { lastEventType: "agent.command" })
    }
  }
  return next
}

export function recordViolation(
  snapshot: RunSnapshot,
  agentId: string,
  _path: string,
): RunSnapshot {
  const zoneViolations = (snapshot.agents[agentId]?.zoneViolations ?? 0) + 1
  return patchAgent(snapshot, agentId, { zoneViolations })
}

export function shouldStop(
  snapshot: RunSnapshot,
  config: HamiltonConfig,
): boolean {
  if (!config.earlyStop.enabled) return false
  const agents = Object.values(snapshot.agents)
  const known = agents.length
  const failed = agents.filter(
    (agent) => agent.state === "died" || agent.state === "error",
  ).length
  if (failed >= config.earlyStop.maxFailedAgents) return true
  return known > 0 && failed / known >= config.earlyStop.failedRatio
}

export function agentLogKey(
  runId: string,
  agentId: string,
  kind: string,
  seq: number,
  suffix?: string,
): string {
  const padded = String(seq).padStart(10, "0")
  return `artifacts/${runId}/agent-${agentId}/${kind}/${padded}-${suffix ?? Date.now()}.json`
}

// ── Deterministic protocol bookkeeping (HAMILTON.md §7) ─────────────────────
//
// Pure compliance over a task's agent rows: did the agent claim, start, do
// work, and declare ready in the canonical order? Violations are derived from
// the stored timestamps only, so they reproduce exactly from any snapshot:
//   - work (milestone / heartbeat / ready) with claimedAt missing → "work
//     before claim" (started/working state alone does not count — old sessions
//     that skipped agent.claimed stay flaggable);
//   - ready without claimedAt → "no claim at ready time";
//   - ready without startedAt → "no start at ready time".

export interface ProtocolCompliance {
  claimed: boolean
  started: boolean
  milestones: number
  errorsReported: number
  subagentsReported: number
  ready: boolean
  violations: string[]
}

// States an agent can only reach after claiming (fallback for sessions where
// claimedAt was never stored but the lifecycle clearly progressed).
const CLAIMED_OR_LATER = new Set([
  "claimed",
  "started",
  "working",
  "ready-for-review",
  "idle",
  "died",
  "error",
  "blocked",
])

export function protocolCompliance(
  snapshot: RunSnapshot,
  taskId: string,
): ProtocolCompliance {
  const agents = Object.values(snapshot.agents).filter(
    (agent) => agent.taskId === taskId,
  )
  const claimed = agents.some(
    (agent) =>
      agent.claimedAt !== undefined || CLAIMED_OR_LATER.has(agent.state),
  )
  const started = agents.some((agent) => agent.startedAt !== undefined)
  const ready = agents.some((agent) => agent.lastReadyAt !== undefined)
  const milestones = agents.reduce(
    (total, agent) => total + agent.milestoneCount,
    0,
  )
  const errorsReported = agents.reduce(
    (total, agent) => total + (agent.errorCount ?? 0),
    0,
  )
  const subagentsReported = agents.reduce(
    (total, agent) => total + (agent.subagentCount ?? 0),
    0,
  )
  const claimedAtSet = agents.some((agent) => agent.claimedAt !== undefined)
  const work =
    milestones > 0 ||
    agents.some((agent) => agent.heartbeatAt !== undefined) ||
    ready
  const violations: string[] = []
  if (work && !claimedAtSet) violations.push("work before claim")
  if (ready && !claimedAtSet) violations.push("no claim at ready time")
  if (ready && !started) violations.push("no start at ready time")
  return {
    claimed,
    started,
    milestones,
    errorsReported,
    subagentsReported,
    ready,
    violations,
  }
}

// ── M2: composite activity (HAMILTON.md §"Composite activity") ──────────────
//
// An agent is "active" while any signal arrived within the activity window:
//   - agent.lastActivityAt — set by agent.* events (milestones/heartbeat/
//     claimed/started), telemetry.opencode for the matching session, and
//     worktree.status_changed git-commit deltas on the agent's branch;
//   - agent.heartbeatAt — bridge liveness beats;
//   - the agent's task lastEventAt — task-side signals for that agent.
// Silence past windowMs = idle; the bridge detecting a stall (stalledAt) or
// silence past 3× windowMs = stalled. Terminal states (died/error) are always
// stalled. windowMs is config-driven, default 120s.
export function agentActivity(
  snapshot: RunSnapshot,
  agentId: string,
  nowMs: number,
  windowMs: number,
): AgentActivity {
  const agent = snapshot.agents[agentId]
  if (agent?.state === "died" || agent?.state === "error") return "stalled"
  const candidates: number[] = []
  for (const ts of [agent?.lastActivityAt, agent?.heartbeatAt]) {
    if (ts === undefined) continue
    const parsed = Date.parse(ts)
    if (Number.isFinite(parsed)) candidates.push(parsed)
  }
  const taskId = agent?.taskId
  const taskLastEventAt =
    taskId !== undefined ? snapshot.tasks[taskId]?.lastEventAt : undefined
  if (taskLastEventAt !== undefined) {
    const parsed = Date.parse(taskLastEventAt)
    if (Number.isFinite(parsed)) candidates.push(parsed)
  }
  if (candidates.length === 0) return "idle"
  const elapsed = nowMs - Math.max(...candidates)
  if (elapsed <= windowMs) return "active"
  if (agent?.stalledAt !== undefined || elapsed > windowMs * 3) return "stalled"
  return "idle"
}

// ── M2: dispatch candidate selection (HAMILTON.md §"Dispatch loop") ─────────
//
// Tasks eligible for dispatch: status "planned" (not "optional"), run not
// stopping, and every depends_on task already "merged". Insertion order of
// snapshot.tasks is preserved (run.planned seeds rows in graph order), so the
// graph's original ordering comes out stable. `_nowMs` is reserved for a
// future time-based dispatch gate; the current selection is graph-only.
export function dispatchCandidates(
  snapshot: RunSnapshot,
  _nowMs?: number,
): Array<{ taskId: string }> {
  if (snapshot.phase === "stopping") return []
  const candidates: Array<{ taskId: string }> = []
  for (const [taskId, task] of Object.entries(snapshot.tasks)) {
    if (task.status !== "planned") continue
    const deps = task.dependsOn ?? []
    const unmerged = deps.some(
      (dep) => snapshot.tasks[dep]?.status !== "merged",
    )
    if (unmerged) continue
    candidates.push({ taskId })
  }
  return candidates
}

// ── M2: merge gating (HAMILTON.md §"Merge authority") ───────────────────────
//
// M3 rewired the gate: a task merges only once it is "approved" (review passed)
// AND the run is autonomous; ready_for_review now enters the review gate
// instead of merging directly. Owner-gated runs hold for the owner board
// (M3 governance), so no merge is triggered here.
export function shouldMerge(
  snapshot: RunSnapshot,
  taskId: string,
  config: HamiltonConfig,
): boolean {
  if (config.mergeAuthority !== "autonomous") return false
  return snapshot.tasks[taskId]?.status === "approved"
}

export interface MergeTarget {
  taskId: string
  branch: string
  parent: string
}

export function mergeTrigger(
  snapshot: RunSnapshot,
  config: HamiltonConfig,
): MergeTarget[] {
  if (snapshot.parent === undefined) return []
  const targets: MergeTarget[] = []
  for (const [taskId, task] of Object.entries(snapshot.tasks)) {
    if (!shouldMerge(snapshot, taskId, config)) continue
    const branch = task.branch
    if (branch === undefined) continue
    targets.push({ taskId, branch, parent: snapshot.parent })
  }
  return targets
}

// ── M3: the gate decision (HAMILTON.md §"Review gate") ──────────────────────
//
// Pure policy over the batch of submissions for one gate round. A role vetoes
// when config.review.vetoRoles contains "*" (every role vetoes) or the role
// name. One veto-role "fail" fails the gate; its findings are the blockers.
// Non-veto ("advisory") fails only land in notes. Fail-closed: no submissions
// at all → fail.

export interface GateDecision {
  verdict: "pass" | "fail"
  /** Findings from veto-role fail reviewers (routed back as blockers). */
  blockers: ReviewFinding[]
  /** All other findings (pass reviewers + advisory fails). */
  notes: ReviewFinding[]
}

export function decideGate(
  submissions: ReviewSubmission[],
  config: HamiltonConfig,
): GateDecision {
  if (submissions.length === 0) {
    return { verdict: "fail", blockers: [], notes: [] }
  }
  const vetoRoles = config.review.vetoRoles
  let vetoFailed = false
  const blockers: ReviewFinding[] = []
  const notes: ReviewFinding[] = []
  for (const submission of submissions) {
    const vetoes =
      vetoRoles.includes("*") || vetoRoles.includes(submission.reviewer)
    if (submission.verdict === "fail" && vetoes) {
      vetoFailed = true
      blockers.push(...submission.findings)
    } else {
      notes.push(...submission.findings)
    }
  }
  return { verdict: vetoFailed ? "fail" : "pass", blockers, notes }
}

// ── M2/M3: action issuance (the RunDO loop's decision output) ───────────────
//
// One CoreAction per task per category, nothing while stopping/finished:
//   - worktree.ensure for every dispatch candidate (branch defaults to
//     `feat/${taskId}` when the graph carries none);
//   - pr.verify for every ready/reviewing task whose verification has not
//     landed yet (issued ONCE — the result is stored on the task row and
//     blocks re-issue; runs in parallel with the review gate);
//   - review.start for every ready-for-review task whose gate has not been
//     populated yet (fresh gate; a rejection resets reviewers in applyEvent,
//     so the gate re-runs after fixes);
//   - merge.execute for every approved task (autonomous runs only — the M2
//     ready→merge path was replaced by the M3 gate);
//   - session.nudge for rejected tasks so the agent gets its findings back;
//   - review.cleanup once an approved/blocked task leaves the gate with a
//     review worktree still provisioned.
// session.start/abort are NOT issued here: the Core dispatcher issues
// session.start once a worktree.ensure has resolved (and session.abort on
// escalation), so the RunDO stays a pure decision-maker.
export function actionsFor(
  snapshot: RunSnapshot,
  config: HamiltonConfig,
): CoreAction[] {
  if (snapshot.phase === "stopping" || snapshot.phase === "finished") return []
  const actions: CoreAction[] = []
  const ensured = new Set<string>()
  for (const candidate of dispatchCandidates(snapshot)) {
    const task = snapshot.tasks[candidate.taskId]
    if (task === undefined || ensured.has(candidate.taskId)) continue
    ensured.add(candidate.taskId)
    actions.push({
      action: "worktree.ensure",
      runId: snapshot.runId ?? "",
      taskId: candidate.taskId,
      parent: snapshot.parent ?? "",
      branch: task.branch ?? `feat/${candidate.taskId}`,
    })
  }
  const runId = snapshot.runId ?? ""
  const parent = snapshot.parent ?? ""
  // One action per (taskId, action), priority order: review.start →
  // merge.execute → session.nudge → review.cleanup.
  const issued = new Set<string>()
  const issue = (action: CoreAction): void => {
    const key = `${action.taskId}:${action.action}`
    if (issued.has(key)) return
    issued.add(key)
    actions.push(action)
  }
  for (const [taskId, task] of Object.entries(snapshot.tasks)) {
    if (
      (task.status === "ready-for-review" || task.status === "reviewing") &&
      task.prVerification === undefined
    ) {
      issue({
        action: "pr.verify",
        runId,
        taskId,
        branch: task.branch ?? `feat/${taskId}`,
        parent,
      })
    }
    if (
      task.status === "ready-for-review" &&
      (task.reviewers === undefined || task.reviewers.length === 0)
    ) {
      issue({
        action: "review.start",
        runId,
        taskId,
        branch: task.branch ?? `feat/${taskId}`,
        parent,
        roles: config.review.roles,
        ...(config.review.model !== undefined
          ? { model: config.review.model }
          : {}),
        zone: task.zone,
        ...(task.contract !== undefined ? { contract: task.contract } : {}),
      })
    }
    if (
      task.status === "approved" &&
      config.mergeAuthority === "autonomous" &&
      snapshot.parent !== undefined &&
      task.branch !== undefined
    ) {
      issue({
        action: "merge.execute",
        runId,
        taskId,
        branch: task.branch,
        parent: snapshot.parent,
      })
    }
    if (
      task.status === "in-progress" &&
      (task.reviewRetries ?? 0) > 0 &&
      (task.reviewFindings ?? []).length > 0 &&
      snapshot.phase !== "stopping"
    ) {
      issue({
        action: "session.nudge",
        runId,
        taskId,
        message: renderNudgeMessage(task),
      })
    }
    if (
      (task.status === "approved" || task.status === "blocked") &&
      task.reviewWorktreePath !== undefined
    ) {
      issue({
        action: "review.cleanup",
        runId,
        taskId,
      })
    }
  }
  return actions
}

// Compact findings digest for the agent after a rejected gate round: the
// accumulated findings (capped at 20) rendered as one line per finding.
function renderNudgeMessage(task: TaskRunState): string {
  const findings = (task.reviewFindings ?? []).slice(0, 20)
  const lines = findings.map(
    (finding) =>
      `- [${finding.id}] ${finding.location}: ${finding.issue}` +
      (finding.suggested_fix !== undefined
        ? ` (suggested: ${finding.suggested_fix})`
        : ""),
  )
  return `Review rejected (attempt ${task.reviewRetries ?? 0}). Findings:\n${lines.join("\n")}`
}

// Best-effort parse of a full Task (from task.dispatched payload) for the `graph`
// storage key. Returns undefined for anything that does not satisfy the schema
// surface — the event still transitions TaskRunState independently.
export function parseTask(value: unknown): Task | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== "string") return undefined
  const role = v.role
  if (
    typeof role !== "string" ||
    !ROLES.includes(role as (typeof ROLES)[number])
  )
    return undefined
  const zone = stringArray(v.zone)
  const dependsOn = stringArray(v.depends_on)
  if (zone === undefined || dependsOn === undefined) return undefined
  const onFailure = v.on_failure
  if (
    typeof onFailure !== "string" ||
    !ON_FAILURES.includes(onFailure as (typeof ON_FAILURES)[number])
  ) {
    return undefined
  }
  if (typeof v.model !== "string") return undefined
  const status = parseTaskStatus(v.status)
  if (status === undefined) return undefined
  const contractValue = v.contract
  if (typeof contractValue !== "object" || contractValue === null)
    return undefined
  const contractRecord = contractValue as Record<string, unknown>
  const inputs = stringArray(contractRecord.inputs)
  const outputs = stringArray(contractRecord.outputs)
  if (inputs === undefined || outputs === undefined) return undefined
  const task: Task = {
    id: v.id,
    role: role as Task["role"],
    zone,
    depends_on: dependsOn,
    status,
    on_failure: onFailure as Task["on_failure"],
    contract: { inputs, outputs },
    model: v.model,
    allowed_subagents: stringArray(v.allowed_subagents) ?? [],
  }
  if (typeof v.budget_cap === "number") task.budget_cap = v.budget_cap
  if (typeof v.branch === "string") task.branch = v.branch
  if (typeof v.pr_title === "string") task.pr_title = v.pr_title
  return task
}

function setTask(snapshot: RunSnapshot, task: TaskRunState): RunSnapshot {
  return { ...snapshot, tasks: { ...snapshot.tasks, [task.id]: task } }
}

function patchTask(
  snapshot: RunSnapshot,
  taskId: string,
  patch: Partial<TaskRunState>,
): RunSnapshot {
  const existing = snapshot.tasks[taskId]
  if (existing === undefined) return snapshot
  return setTask(snapshot, { ...existing, ...patch })
}

function setAgent(snapshot: RunSnapshot, agent: AgentRunState): RunSnapshot {
  return { ...snapshot, agents: { ...snapshot.agents, [agent.agentId]: agent } }
}

function patchAgent(
  snapshot: RunSnapshot,
  agentId: string,
  patch: Partial<AgentRunState>,
): RunSnapshot {
  // Defensive: any agent.* event registers the agent row if missing (agents
  // may emit before the orchestrator's task.dispatched lands).
  const existing = snapshot.agents[agentId]
  const agent: AgentRunState = existing ?? {
    agentId,
    state: "working",
    failures: 0,
    zoneViolations: 0,
    milestoneCount: 0,
    ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
  }
  return setAgent(snapshot, { ...agent, ...patch })
}

function withTaskStatus(
  snapshot: RunSnapshot,
  taskId: string,
  status: TaskStatus,
): RunSnapshot {
  const existing = snapshot.tasks[taskId]
  if (existing === undefined) {
    return setTask(snapshot, { id: taskId, status, role: "", zone: [] })
  }
  if (existing.status === status) return snapshot
  return patchTask(snapshot, taskId, { status })
}

// M3 — reviewer rows from a review.assigned payload. Skips malformed entries
// (missing idx/role); returns undefined when nothing parses.
function parseReviewers(value: unknown): ReviewerEntry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const reviewers: ReviewerEntry[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.idx !== "number") continue
    if (typeof record.role !== "string") continue
    const entry: ReviewerEntry = { idx: record.idx, role: record.role }
    if (typeof record.sessionId === "string") entry.sessionId = record.sessionId
    reviewers.push(entry)
  }
  return reviewers.length > 0 ? reviewers : undefined
}

// M3 — findings from a review.submitted payload. Skips malformed findings;
// returns undefined when none parse (accumulation is append-only).
function parseFindings(value: unknown): ReviewFinding[] | undefined {
  if (!Array.isArray(value)) return undefined
  const findings: ReviewFinding[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== "string") continue
    if (typeof record.location !== "string") continue
    if (typeof record.issue !== "string") continue
    const finding: ReviewFinding = {
      id: record.id,
      location: record.location,
      issue: record.issue,
    }
    if (typeof record.suggested_fix === "string") {
      finding.suggested_fix = record.suggested_fix
    }
    findings.push(finding)
  }
  return findings.length > 0 ? findings : undefined
}

// M3 — drop optional gate fields from a task row (fresh gate after a
// rejection; exactOptionalPropertyTypes forbids assigning undefined).
function clearTaskFields(
  snapshot: RunSnapshot,
  taskId: string,
  fields: readonly (
    | "reviewers"
    | "reviewRetries"
    | "reviewWorktreePath"
    | "reviewFindings"
  )[],
): RunSnapshot {
  const existing = snapshot.tasks[taskId]
  if (existing === undefined) return snapshot
  const task: TaskRunState = { ...existing }
  for (const field of fields) delete task[field]
  return setTask(snapshot, task)
}

function setBranch(snapshot: RunSnapshot, row: BranchRunState): RunSnapshot {
  return {
    ...snapshot,
    branches: { ...snapshot.branches, [row.branch]: row },
  }
}

// Pure transition core: (tasks, agents, phase) + event → new (tasks, agents, phase).
// Everything else (seq/lastEventId bookkeeping, KV write-through, DO forwarding) is
// handled by RunDO.fetch and stays out of here so the logic is unit-testable.
export function applyEvent(
  snapshot: RunSnapshot,
  evt: HamiltonEvent,
  config?: HamiltonConfig,
): RunSnapshot {
  const payload = payloadRecord(evt.payload)
  switch (evt.type) {
    case "run.planned": {
      // The CLI emits run.planned with the full graph ({ tasks, parent }) —
      // register/refresh TaskRunState rows, keeping live fields (status,
      // lastEventAt, ...) on rows that are already past "planned".
      let next: RunSnapshot = { ...snapshot, phase: "planned" }
      const rawTasks = payload.tasks
      if (Array.isArray(rawTasks)) {
        const tasks = { ...next.tasks }
        for (const raw of rawTasks) {
          if (typeof raw !== "object" || raw === null) continue
          const record = raw as Record<string, unknown>
          if (typeof record.id !== "string") continue
          const existing = tasks[record.id]
          // A row already past "planned" is live state (dispatch/merge already
          // happened); only never-dispatched rows take the graph's status.
          const status =
            existing !== undefined && existing.status !== "planned"
              ? existing.status
              : (parseTaskStatus(record.status) ?? "planned")
          const role =
            typeof record.role === "string"
              ? record.role
              : (existing?.role ?? "")
          const zone = stringArray(record.zone) ?? existing?.zone ?? []
          const dependsOn =
            stringArray(record.depends_on) ?? existing?.dependsOn ?? []
          const branch =
            typeof record.branch === "string" ? record.branch : existing?.branch
          const contract =
            typeof record.contract === "object" && record.contract !== null
              ? (record.contract as { inputs?: unknown; outputs?: unknown })
              : undefined
          const contractParsed =
            contract !== undefined &&
            Array.isArray(contract.inputs) &&
            contract.inputs.every((i) => typeof i === "string") &&
            Array.isArray(contract.outputs) &&
            contract.outputs.every((o) => typeof o === "string")
              ? {
                  inputs: contract.inputs as string[],
                  outputs: contract.outputs as string[],
                }
              : existing?.contract
          tasks[record.id] = {
            ...existing,
            id: record.id,
            status,
            role,
            zone,
            dependsOn,
            ...(branch !== undefined ? { branch } : {}),
            ...(contractParsed !== undefined
              ? { contract: contractParsed }
              : {}),
          }
        }
        next = { ...next, tasks }
      }
      const parent =
        typeof payload.parent === "string" ? payload.parent : undefined
      if (parent !== undefined) next = { ...next, parent }
      return next
    }
    case "run.pause":
      return { ...snapshot, phase: "paused" }
    case "run.resume":
      return { ...snapshot, phase: "running" }
    case "run.finish":
      return { ...snapshot, phase: "finished" }
    case "task.dispatched": {
      const taskId = evt.taskId
      if (taskId === undefined) return snapshot
      const role = typeof payload.role === "string" ? payload.role : ""
      const branch =
        typeof payload.branch === "string" ? payload.branch : undefined
      const zone = stringArray(payload.zone) ?? []
      return setTask(snapshot, {
        id: taskId,
        status: "in-progress",
        role,
        branch,
        zone,
      })
    }
    case "task.status_changed": {
      const taskId = evt.taskId
      const status = parseTaskStatus(payload.status)
      if (taskId === undefined || status === undefined) return snapshot
      return withTaskStatus(snapshot, taskId, status)
    }
    case "task.merged": {
      const taskId = evt.taskId
      if (taskId === undefined) return snapshot
      const next = withTaskStatus(snapshot, taskId, "merged")
      // The run is finished when every task has merged (the M2 exit).
      const allMerged = Object.values(next.tasks).every(
        (task) => task.status === "merged",
      )
      return allMerged ? { ...next, phase: "finished" } : next
    }
    case "task.escalated":
    case "task.blocked": {
      const taskId = evt.taskId
      return taskId === undefined
        ? snapshot
        : withTaskStatus(snapshot, taskId, "blocked")
    }
    case "worktree.created": {
      const branch =
        typeof payload.branch === "string" ? payload.branch : undefined
      if (branch === undefined) return snapshot
      const row: BranchRunState = {
        branch,
        parent: typeof payload.parent === "string" ? payload.parent : "",
        ...(typeof payload.worktreePath === "string"
          ? { worktreePath: payload.worktreePath }
          : {}),
      }
      return setBranch(snapshot, row)
    }
    case "worktree.status_changed": {
      const branch =
        typeof payload.branch === "string" ? payload.branch : undefined
      if (branch === undefined) return snapshot
      const prev = snapshot.branches?.[branch]
      let next = snapshot
      if (prev !== undefined) {
        const patch: Partial<BranchRunState> = {}
        if (typeof payload.ahead === "number") patch.ahead = payload.ahead
        if (typeof payload.behind === "number") patch.behind = payload.behind
        if (typeof payload.dirtyCount === "number")
          patch.dirtyCount = payload.dirtyCount
        if (typeof payload.unpushedCount === "number")
          patch.unpushedCount = payload.unpushedCount
        if (typeof payload.commitCount === "number")
          patch.commitCount = payload.commitCount
        if (typeof payload.merged === "boolean") patch.merged = payload.merged
        if (typeof payload.lastEventAt === "string")
          patch.lastEventAt = payload.lastEventAt
        next = setBranch(next, { ...prev, ...patch })
      }
      // Git commits are activity: a commitCount delta on the branch's task
      // agent refreshes lastActivityAt (drift-only updates do not).
      const commitCount =
        typeof payload.commitCount === "number"
          ? payload.commitCount
          : undefined
      if (commitCount !== undefined && commitCount > (prev?.commitCount ?? 0)) {
        for (const agent of Object.values(next.agents)) {
          const taskId = agent.taskId
          const task = taskId !== undefined ? next.tasks[taskId] : undefined
          if (task !== undefined && task.branch === branch) {
            next = patchAgent(next, agent.agentId, { lastActivityAt: evt.ts })
          }
        }
      }
      return next
    }
    case "worktree.removed": {
      const branch =
        typeof payload.branch === "string" ? payload.branch : undefined
      if (branch === undefined) return snapshot
      const branches = snapshot.branches
      if (branches === undefined || branches[branch] === undefined)
        return snapshot
      const next = { ...branches }
      delete next[branch]
      return { ...snapshot, branches: next }
    }
    case "agent.claimed":
    case "agent.started": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const agent: AgentRunState = {
        agentId,
        state: evt.type === "agent.started" ? "started" : "claimed",
        failures: 0,
        zoneViolations: 0,
        milestoneCount: 0,
        ...(evt.type === "agent.started"
          ? { startedAt: evt.ts }
          : { claimedAt: evt.ts }),
        ...checkpointReported(payload, evt.ts),
        ...(evt.taskId !== undefined ? { taskId: evt.taskId } : {}),
      }
      let next = setAgent(snapshot, agent)
      const taskId = evt.taskId
      // While stopping, dispatch is halted: claimed/started register the agent
      // but must not promote planned tasks (healthy agents still finish).
      if (taskId !== undefined && snapshot.phase !== "stopping") {
        const task = snapshot.tasks[taskId]
        if (task !== undefined && task.status === "planned") {
          next = withTaskStatus(next, taskId, "in-progress")
        }
      }
      return next
    }
    case "agent.milestone": {
      const agentId = evt.agentId
      const knownTaskId =
        agentId !== undefined ? snapshot.agents[agentId]?.taskId : undefined
      const taskId = evt.taskId ?? knownTaskId
      let next =
        taskId !== undefined
          ? patchTask(snapshot, taskId, {
              lastEventType: "agent.milestone",
              lastEventAt: evt.ts,
            })
          : snapshot
      if (agentId !== undefined) {
        const current = snapshot.agents[agentId]
        const working =
          current !== undefined &&
          (current.state === "claimed" || current.state === "started")
        const patch: Partial<AgentRunState> = {
          lastActivityAt: evt.ts,
          milestoneCount: (current?.milestoneCount ?? 0) + 1,
          ...(taskId !== undefined ? { taskId } : {}),
          ...checkpointReported(payload, evt.ts),
        }
        if (working) patch.state = "working"
        next = patchAgent(next, agentId, patch)
      }
      return next
    }
    case "agent.heartbeat": {
      const agentId = evt.agentId
      return agentId === undefined
        ? snapshot
        : patchAgent(snapshot, agentId, { heartbeatAt: evt.ts })
    }
    case "agent.ready_for_review": {
      const agentId = evt.agentId
      const knownTaskId =
        agentId !== undefined ? snapshot.agents[agentId]?.taskId : undefined
      const taskId = evt.taskId ?? knownTaskId
      let next =
        taskId !== undefined
          ? withTaskStatus(snapshot, taskId, "ready-for-review")
          : snapshot
      // M3: after a rejected gate round, ready_for_review opens a FRESH gate —
      // drop the old reviewers/findings/worktree so actionsFor re-issues
      // review.start. reviewRetries survives: it caps total rejection rounds.
      if (taskId !== undefined) {
        const task = next.tasks[taskId]
        if (task !== undefined && (task.reviewRetries ?? 0) > 0) {
          next = clearTaskFields(next, taskId, [
            "reviewers",
            "reviewFindings",
            "reviewWorktreePath",
          ])
        }
      }
      if (agentId !== undefined) {
        next = patchAgent(next, agentId, {
          state: "ready-for-review",
          lastReadyAt: evt.ts,
        })
      }
      return next
    }
    case "agent.stalled": {
      const agentId = evt.agentId
      return agentId === undefined
        ? snapshot
        : patchAgent(snapshot, agentId, { stalledAt: evt.ts })
    }
    case "agent.idle": {
      const agentId = evt.agentId
      return agentId === undefined
        ? snapshot
        : patchAgent(snapshot, agentId, { state: "idle", busy: false })
    }
    case "agent.died": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const failures = (snapshot.agents[agentId]?.failures ?? 0) + 1
      let next = patchAgent(snapshot, agentId, {
        state: "died",
        diedAt: evt.ts,
        failures,
      })
      if (config !== undefined && shouldStop(next, config)) {
        next = { ...next, phase: "stopping" }
      }
      return next
    }
    case "agent.error": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const current = snapshot.agents[agentId]
      const failures = (current?.failures ?? 0) + 1
      let next = patchAgent(snapshot, agentId, {
        state: "error",
        failures,
        errorCount: (current?.errorCount ?? 0) + 1,
        ...checkpointReported(payload, evt.ts),
      })
      if (config !== undefined && shouldStop(next, config)) {
        next = { ...next, phase: "stopping" }
      }
      return next
    }
    case "agent.blocked": {
      // Checkpoint phase "blocked" (agent self-report). Unknown agents are
      // ignored — the row must exist for the report to attach to.
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      if (snapshot.agents[agentId] === undefined) return snapshot
      return patchAgent(snapshot, agentId, {
        state: "blocked",
        ...checkpointReported(payload, evt.ts),
      })
    }
    case "agent.subagent_spawned": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const role = typeof payload.role === "string" ? payload.role : undefined
      return patchAgent(snapshot, agentId, {
        subagentCount: (snapshot.agents[agentId]?.subagentCount ?? 0) + 1,
        ...(role !== undefined ? { lastSubagentRole: role } : {}),
      })
    }
    case "agent.subagent_result": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const role = typeof payload.role === "string" ? payload.role : undefined
      return role === undefined
        ? snapshot
        : patchAgent(snapshot, agentId, { lastSubagentRole: role })
    }
    case "agent.command": {
      const agentId = evt.agentId
      const command = payload.command
      if (agentId === undefined || typeof command !== "string") return snapshot
      return patchAgent(snapshot, agentId, { lastCommand: command })
    }
    case "agent.zone_violation": {
      const agentId = evt.agentId
      if (agentId === undefined) return snapshot
      const zoneViolations = (snapshot.agents[agentId]?.zoneViolations ?? 0) + 1
      return patchAgent(snapshot, agentId, { zoneViolations })
    }
    case "review.assigned": {
      // Payload carries the reviewer rows ({ idx, role, sessionId }) plus the
      // review worktree path; taskId may live in the payload or the envelope.
      const payloadTaskId = payload.taskId
      const taskId =
        evt.taskId ??
        (typeof payloadTaskId === "string" ? payloadTaskId : undefined)
      if (taskId === undefined) return snapshot
      const reviewers = parseReviewers(payload.reviewers)
      const worktreePath =
        typeof payload.worktreePath === "string"
          ? payload.worktreePath
          : undefined
      const existing = snapshot.tasks[taskId]
      const task: TaskRunState = existing ?? {
        id: taskId,
        status: "reviewing",
        role: "",
        zone: [],
      }
      return setTask(snapshot, {
        ...task,
        status: "reviewing",
        ...(reviewers !== undefined ? { reviewers } : {}),
        ...(worktreePath !== undefined
          ? { reviewWorktreePath: worktreePath }
          : {}),
      })
    }
    case "review.started": {
      const taskId = evt.taskId
      return taskId === undefined
        ? snapshot
        : withTaskStatus(snapshot, taskId, "reviewing")
    }
    case "review.submitted": {
      // Payload is ReviewSubmission-shaped ({ reviewer, idx, verdict,
      // findings, ... }). taskId is required; falls back to the agent's task.
      const taskId =
        evt.taskId ??
        (evt.agentId !== undefined
          ? snapshot.agents[evt.agentId]?.taskId
          : undefined)
      if (taskId === undefined) return snapshot
      const idx = payload.idx
      if (typeof idx !== "number") return snapshot
      const reviewer = payload.reviewer
      if (typeof reviewer !== "string") return snapshot
      const verdict =
        payload.verdict === "pass"
          ? "pass"
          : payload.verdict === "fail"
            ? "fail"
            : undefined
      if (verdict === undefined) return snapshot
      const findings = parseFindings(payload.findings)
      const existing = snapshot.tasks[taskId]
      const reviewers = [...(existing?.reviewers ?? [])]
      const entryIdx = reviewers.findIndex((entry) => entry.idx === idx)
      const prevEntry = entryIdx >= 0 ? reviewers[entryIdx] : undefined
      if (prevEntry !== undefined) {
        const merged: ReviewerEntry = {
          ...prevEntry,
          verdict,
          submittedAt: evt.ts,
        }
        if (findings !== undefined) {
          merged.findings = [...(prevEntry.findings ?? []), ...findings]
        }
        reviewers[entryIdx] = merged
      } else {
        reviewers.push({
          idx,
          role: reviewer,
          verdict,
          submittedAt: evt.ts,
          ...(findings !== undefined ? { findings } : {}),
        })
      }
      const reviewFindings = [
        ...(existing?.reviewFindings ?? []),
        ...(findings ?? []),
      ]
      const task: TaskRunState = existing ?? {
        id: taskId,
        status: "reviewing",
        role: "",
        zone: [],
      }
      return setTask(snapshot, { ...task, reviewers, reviewFindings })
    }
    case "review.verdict": {
      const taskId = evt.taskId
      if (taskId === undefined) return snapshot
      if (payload.verdict === "pass") {
        // Keep reviewFindings: the decision record stays on the task.
        return withTaskStatus(snapshot, taskId, "approved")
      }
      const reviewRetries = (snapshot.tasks[taskId]?.reviewRetries ?? 0) + 1
      let next = withTaskStatus(snapshot, taskId, "in-progress")
      next = patchTask(next, taskId, { reviewRetries })
      const maxRetries = config?.review.maxRetries
      if (maxRetries !== undefined && reviewRetries >= maxRetries) {
        next = withTaskStatus(next, taskId, "blocked")
      }
      return next
    }
    case "telemetry.opencode": {
      // Any telemetry from an agent's OpenCode session counts as activity for
      // that agent (sessionId → agentId); unknown sessions are ignored.
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId : undefined
      const agentId = sessionId ?? evt.agentId
      if (agentId === undefined) return snapshot
      if (snapshot.agents[agentId] === undefined) return snapshot
      return patchAgent(snapshot, agentId, { lastActivityAt: evt.ts })
    }
    default:
      return snapshot
  }
}

export type AgentEndpoint =
  | "register"
  | "heartbeat"
  | "activity"
  | "stalled"
  | "idle"
  | "died"

export type ForwardTarget =
  | { kind: "task"; taskId: string; status: TaskStatus }
  | {
      kind: "agent"
      agentId: string
      endpoint: AgentEndpoint
      body: Record<string, unknown>
    }

// Pure derivation of the TaskDO/AgentDO stubs RunDO should poke for an event:
// task transitions are diffed between the pre/post snapshots, agent pokes are
// derived from the event type itself.
export function forwardTargets(
  prev: RunSnapshot,
  next: RunSnapshot,
  evt: HamiltonEvent,
): ForwardTarget[] {
  const targets: ForwardTarget[] = []
  for (const taskId of Object.keys(next.tasks)) {
    const before = prev.tasks[taskId]?.status
    const after = next.tasks[taskId]?.status
    if (after !== undefined && after !== before) {
      targets.push({ kind: "task", taskId, status: after })
    }
  }
  const agentId = evt.agentId
  if (agentId === undefined) return targets
  switch (evt.type) {
    case "agent.claimed":
    case "agent.started":
      if (evt.taskId !== undefined) {
        targets.push({
          kind: "agent",
          agentId,
          endpoint: "register",
          body: { taskId: evt.taskId },
        })
      }
      break
    case "agent.heartbeat":
      targets.push({ kind: "agent", agentId, endpoint: "heartbeat", body: {} })
      break
    case "agent.milestone":
      targets.push({ kind: "agent", agentId, endpoint: "activity", body: {} })
      break
    case "agent.stalled":
      targets.push({ kind: "agent", agentId, endpoint: "stalled", body: {} })
      break
    case "agent.idle":
      targets.push({ kind: "agent", agentId, endpoint: "idle", body: {} })
      break
    case "agent.died":
      targets.push({ kind: "agent", agentId, endpoint: "died", body: {} })
      break
    default:
      break
  }
  return targets
}

export class RunDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/event") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 })
      }
      const body = await readJsonBody(request)
      if (body === undefined || !isHamiltonEvent(body)) {
        return new Response("invalid event", { status: 400 })
      }
      return this.handleEvent(body)
    }
    if (url.pathname === "/state") {
      const [tasks, agents, phase, lastSeq, branches, parent] =
        await Promise.all([
          this.ctx.storage.get<Record<string, TaskRunState>>(KEYS.tasks),
          this.ctx.storage.get<Record<string, AgentRunState>>(KEYS.agents),
          this.ctx.storage.get<string>(KEYS.phase),
          this.ctx.storage.get<number>(KEYS.lastSeq),
          this.ctx.storage.get<Record<string, BranchRunState>>(KEYS.branches),
          this.ctx.storage.get<string>(KEYS.parent),
        ])
      return Response.json({
        runId: this.runId(),
        phase: phase ?? "planned",
        seq: lastSeq ?? 0,
        updatedAt: new Date().toISOString(),
        parent: parent ?? "",
        tasks: Object.values(tasks ?? {}),
        agents: Object.values(agents ?? {}),
        branches: Object.values(branches ?? {}),
      })
    }
    return new Response("not found", { status: 404 })
  }

  private runId(): string {
    const name = this.ctx.id.name
    return name === undefined ? "default" : name.slice(name.indexOf(":") + 1)
  }

  private configValue: HamiltonConfig | undefined
  private get config(): HamiltonConfig {
    if (this.configValue === undefined) {
      this.configValue = parseConfig(this.env.CONFIG)
    }
    return this.configValue
  }

  // Telemetry-derived supervision: inspect telemetry.opencode events BEFORE
  // applyEvent so the recorded command/violation state lands in the snapshot
  // that gets persisted with this event.
  private supervise(evt: HamiltonEvent, snapshot: RunSnapshot): RunSnapshot {
    if (evt.type !== "telemetry.opencode") return snapshot
    const payload = payloadRecord(evt.payload)
    const sessionId =
      typeof payload.sessionId === "string" ? payload.sessionId : undefined
    const agentId = sessionId ?? evt.agentId
    if (agentId === undefined) return snapshot
    const taskId = snapshot.agents[agentId]?.taskId
    const zone = taskId !== undefined ? snapshot.tasks[taskId]?.zone : undefined
    let next = snapshot
    const extracted = extractBashCommand(evt.payload, this.config.watchCommands)
    if (extracted !== null && extracted.matched !== null) {
      next = recordCommand(next, agentId, extracted.command, extracted.matched)
      this.logArtifact(evt, agentId, "commands")
    }
    const violation = findZoneViolation(evt.payload, zone ?? [])
    if (violation !== null) {
      next = recordViolation(next, agentId, violation)
      this.logArtifact(evt, agentId, "violations")
    }
    return next
  }

  private logAgentArtifacts(evt: HamiltonEvent): void {
    const agentId = evt.agentId
    if (agentId === undefined) return
    if (evt.type === "agent.milestone") {
      this.logArtifact(evt, agentId, "milestones")
    } else if (
      evt.type === "agent.ready_for_review" ||
      evt.type === "agent.subagent_result"
    ) {
      this.logArtifact(evt, agentId, "reports")
    }
  }

  // Append-only per-agent log. Fire-and-forget with a swallow catch: a failed
  // artifact write must never fail event processing.
  private logArtifact(evt: HamiltonEvent, agentId: string, kind: string): void {
    const key = agentLogKey(evt.runId, agentId, kind, evt.seq, evt.id)
    const body = { ...payloadRecord(evt.payload), ts: evt.ts, seq: evt.seq }
    void this.env.ARTIFACTS.put(key, JSON.stringify(body)).catch(() => {})
  }

  // M3 — one review submission document per reviewer per gate round:
  // artifacts/<runId>/review/<taskId>/<idx>-<reviewer>.json.
  private logReviewSubmission(
    evt: HamiltonEvent,
    prev: RunSnapshot,
    _next: RunSnapshot,
  ): void {
    const taskId =
      evt.taskId ??
      (evt.agentId !== undefined ? prev.agents[evt.agentId]?.taskId : undefined)
    if (taskId === undefined) return
    const payload = payloadRecord(evt.payload)
    const idx = payload.idx
    const reviewer = payload.reviewer
    if (typeof idx !== "number" || typeof reviewer !== "string") return
    const key = `artifacts/${evt.runId}/review/${taskId}/${idx}-${reviewer}.json`
    const body = { ...payload, ts: evt.ts, seq: evt.seq }
    void this.env.ARTIFACTS.put(key, JSON.stringify(body)).catch(() => {})
  }

  // M3 — the merge decision record: artifacts/<runId>/merge-log/<seq>-<taskId>.json.
  private logMerge(evt: HamiltonEvent, snapshot: RunSnapshot): void {
    const taskId = evt.taskId
    if (taskId === undefined) return
    const task = snapshot.tasks[taskId]
    if (task === undefined) return
    const payload = payloadRecord(evt.payload)
    const commit = typeof payload.commit === "string" ? payload.commit : ""
    const key = `artifacts/${evt.runId}/merge-log/${String(evt.seq).padStart(10, "0")}-${taskId}.json`
    const body = {
      commit,
      branch: task.branch ?? "",
      parent: snapshot.parent ?? "",
    }
    void this.env.ARTIFACTS.put(key, JSON.stringify(body)).catch(() => {})
  }

  // M3 — rebuild the batch of ReviewSubmissions for a gate round from the
  // task's reviewer rows (verdicts + per-reviewer findings recorded by
  // applyEvent), so decideGate can attribute findings by veto role.
  private submissionsForTask(task: TaskRunState): ReviewSubmission[] {
    const submissions: ReviewSubmission[] = []
    for (const entry of task.reviewers ?? []) {
      if (entry.verdict === undefined) continue
      submissions.push({
        reviewer: entry.role,
        idx: entry.idx,
        verdict: entry.verdict,
        findings: entry.findings ?? [],
      })
    }
    return submissions
  }

  // M3 — when the last reviewer of a gate round has submitted, DECIDE and
  // emit the synthesized review.verdict back through the bus. The queue
  // consumer feeds it to RunDO /event where the normal dedupe (dedupe:<id>)
  // prevents double application, and applyEvent lands the task on
  // approved/in-progress/blocked. The seq comes from the SAME shared counter
  // the Core's bus uses (seq:<runId>:counter) so the synthesized event cannot
  // collide with real bus events in the append-only log; a failed send is
  // swallowed (the state machine already recorded the submissions; the
  // verdict can be re-derived from the next review.submitted).
  private async maybeEmitVerdict(
    evt: HamiltonEvent,
    snapshot: RunSnapshot,
    lastSeq: number,
  ): Promise<void> {
    const taskId =
      evt.taskId ??
      (evt.agentId !== undefined
        ? snapshot.agents[evt.agentId]?.taskId
        : undefined)
    if (taskId === undefined) return
    const task = snapshot.tasks[taskId]
    if (task === undefined) return
    const reviewers = task.reviewers ?? []
    if (reviewers.length === 0) return
    if (reviewers.some((entry) => entry.verdict === undefined)) return
    const decision = decideGate(this.submissionsForTask(task), this.config)
    // Shared seq counter (same key the Core bus uses): get+put race with the
    // Core is possible but rare in-process; dedupe-by-id protects RunDO.
    const counterKey = `seq:${evt.runId}:counter`
    const rawCounter = await this.env.REGISTRY.get(counterKey)
    const nextSeq =
      rawCounter === null ? 1 : Number.parseInt(rawCounter, 10) + 1
    await this.env.REGISTRY.put(counterKey, String(nextSeq))
    const verdictSeq = Math.max(nextSeq, lastSeq + 1)
    const verdictEvent: HamiltonEvent = {
      id: crypto.randomUUID(),
      type: "review.verdict",
      ts: new Date().toISOString(),
      runId: evt.runId,
      taskId,
      // Must exceed the last seq RunDO has applied (the incoming submission's
      // own seq) or the /event seq check would dedupe it.
      seq: verdictSeq,
      payload: {
        verdict: decision.verdict,
        findings: decision.blockers,
        retries:
          decision.verdict === "fail"
            ? (task.reviewRetries ?? 0) + 1
            : (task.reviewRetries ?? 0),
      },
    }
    // The verdict must ALSO land in the Core's event log (EVENTS KV) so the
    // dashboard tail and /api/events see it — BUS.send alone reaches RunDO
    // but bypasses the append-only log.
    const verdictLogKey = `evt:${evt.runId}:${String(verdictSeq).padStart(10, "0")}`
    await this.env.EVENTS.put(
      verdictLogKey,
      JSON.stringify(verdictEvent),
    ).catch(() => {})
    await this.env.BUS.send(verdictEvent).catch(() => {})
  }

  private async handleEvent(evt: HamiltonEvent): Promise<Response> {
    const lastSeq = (await this.ctx.storage.get<number>(KEYS.lastSeq)) ?? 0
    if (evt.seq <= lastSeq) {
      return Response.json({ ok: true, deduped: true })
    }
    const dedupeKey = `dedupe:${evt.id}`
    if ((await this.env.REGISTRY.get(dedupeKey)) !== null) {
      return Response.json({ ok: true, deduped: true })
    }
    await this.env.REGISTRY.put(dedupeKey, "1", {
      expirationTtl: DEDUPE_TTL_SECONDS,
    })

    const [graph, tasks, agents, phase, branches, parent] = await Promise.all([
      this.ctx.storage.get<Task[]>(KEYS.graph),
      this.ctx.storage.get<Record<string, TaskRunState>>(KEYS.tasks),
      this.ctx.storage.get<Record<string, AgentRunState>>(KEYS.agents),
      this.ctx.storage.get<string>(KEYS.phase),
      this.ctx.storage.get<Record<string, BranchRunState>>(KEYS.branches),
      this.ctx.storage.get<string>(KEYS.parent),
    ])
    const snapshot: RunSnapshot = {
      runId: this.runId(),
      tasks: tasks ?? {},
      agents: agents ?? {},
      phase: phase ?? "planned",
      ...(branches !== undefined ? { branches } : {}),
      ...(parent !== undefined ? { parent } : {}),
    }
    const supervised = this.supervise(evt, snapshot)
    const next = applyEvent(supervised, evt, this.config)
    this.logAgentArtifacts(evt)
    if (evt.type === "review.submitted") {
      this.logReviewSubmission(evt, supervised, next)
      await this.maybeEmitVerdict(evt, next, lastSeq)
    } else if (evt.type === "task.merged") {
      this.logMerge(evt, next)
    }
    let nextGraph = graph ?? []
    if (evt.type === "task.dispatched") {
      const parsed =
        parseTask(payloadRecord(evt.payload).task) ?? parseTask(evt.payload)
      if (parsed !== undefined && !nextGraph.some((t) => t.id === parsed.id)) {
        nextGraph = [...nextGraph, parsed]
      }
    }
    await this.ctx.storage.put({
      [KEYS.graph]: nextGraph,
      [KEYS.tasks]: next.tasks,
      [KEYS.agents]: next.agents,
      [KEYS.phase]: next.phase,
      [KEYS.branches]: next.branches ?? {},
      [KEYS.parent]: next.parent ?? "",
      [KEYS.lastSeq]: evt.seq,
      [KEYS.lastEventId]: evt.id,
    })
    await this.env.REGISTRY.put(
      `state:${evt.runId}:run`,
      JSON.stringify({
        runId: evt.runId,
        phase: next.phase,
        seq: evt.seq,
        updatedAt: new Date().toISOString(),
        parent: next.parent ?? "",
        tasks: Object.values(next.tasks),
        agents: Object.values(next.agents),
        branches: Object.values(next.branches ?? {}),
      }),
    )
    for (const target of forwardTargets(snapshot, next, evt)) {
      this.fire(target, evt.runId)
    }
    // A re-ready after rejection opens a fresh gate round: drop the issued
    // markers for review.start and session.nudge so the next maybeAct pass
    // can re-issue them (the 24h TTL would otherwise block the re-review).
    if (evt.type === "agent.ready_for_review" && evt.taskId !== undefined) {
      const task = next.tasks[evt.taskId]
      if (task !== undefined && (task.reviewRetries ?? 0) > 0) {
        await Promise.allSettled([
          this.env.REGISTRY.delete(
            `issued:${evt.runId}:${evt.taskId}:review.start`,
          ),
          this.env.REGISTRY.delete(
            `issued:${evt.runId}:${evt.taskId}:session.nudge`,
          ),
        ])
      }
    }
    await this.maybeAct(next, evt.runId)
    return Response.json({ ok: true })
  }

  // The conductor's hands: issue CoreActions for dispatchable tasks and
  // merges over the CORE service binding (the Core executor runs them).
  // Deduped via REGISTRY `issued:` markers so redelivery never double-issues.
  private async maybeAct(snapshot: RunSnapshot, runId: string): Promise<void> {
    const actions = actionsFor(snapshot, this.config)
    // Sequential by design: each action's issued-marker check/write must
    // complete before the next (KV get→put ordering within the loop).
    // oxlint-disable-next-line no-await-in-loop
    for (const action of actions) {
      const issuedKey = `issued:${runId}:${action.taskId}:${action.action}`
      // oxlint-disable-next-line no-await-in-loop
      if ((await this.env.REGISTRY.get(issuedKey)) !== null) continue
      // oxlint-disable-next-line no-await-in-loop
      await this.env.REGISTRY.put(issuedKey, "1", {
        expirationTtl: ISSUED_TTL_SECONDS,
      })
      try {
        // oxlint-disable-next-line no-await-in-loop
        const response = await this.env.CORE.fetch("http://core/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action),
        })
        // oxlint-disable-next-line no-await-in-loop
        const result = (await response.json()) as CoreActionResult
        if (!result.ok) {
          // Retry on the next event: drop the issued marker so a later
          // maybeAct pass re-attempts the action (bounded by event cadence).
          // oxlint-disable-next-line no-await-in-loop
          await this.env.REGISTRY.delete(issuedKey)
          // oxlint-disable-next-line no-await-in-loop
          await this.env.REGISTRY.put(
            `failed:${runId}:${action.taskId}:${action.action}`,
            result.error,
          )
        } else if (
          action.action === "pr.verify" &&
          result.prVerification !== undefined
        ) {
          // The verification landed: persist it on the task row so actionsFor
          // stops issuing pr.verify (the issued marker stays up — no re-issue
          // after the result is stored).
          // oxlint-disable-next-line no-await-in-loop
          await this.storePrVerification(
            runId,
            action.taskId,
            result.prVerification,
          )
        }
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop
        await this.env.REGISTRY.delete(issuedKey)
        // oxlint-disable-next-line no-await-in-loop
        await this.env.REGISTRY.put(
          `failed:${runId}:${action.taskId}:${action.action}`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  // pr.verify result write-through: patch the task row in DO storage AND
  // rewrite the REGISTRY run snapshot in the same shape the /event write-through
  // produces, so dashboards see the verification without waiting for the next
  // bus event.
  private async storePrVerification(
    runId: string,
    taskId: string,
    verification: PrVerification,
  ): Promise<void> {
    const [tasks, agents, phase, lastSeq, branches, parent] = await Promise.all(
      [
        this.ctx.storage.get<Record<string, TaskRunState>>(KEYS.tasks),
        this.ctx.storage.get<Record<string, AgentRunState>>(KEYS.agents),
        this.ctx.storage.get<string>(KEYS.phase),
        this.ctx.storage.get<number>(KEYS.lastSeq),
        this.ctx.storage.get<Record<string, BranchRunState>>(KEYS.branches),
        this.ctx.storage.get<string>(KEYS.parent),
      ],
    )
    const task = tasks?.[taskId]
    if (task === undefined) return
    const nextTasks = {
      ...tasks,
      [taskId]: { ...task, prVerification: verification },
    }
    await this.ctx.storage.put(KEYS.tasks, nextTasks)
    await this.env.REGISTRY.put(
      `state:${runId}:run`,
      JSON.stringify({
        runId,
        phase: phase ?? "planned",
        seq: lastSeq ?? 0,
        updatedAt: new Date().toISOString(),
        parent: parent ?? "",
        tasks: Object.values(nextTasks),
        agents: Object.values(agents ?? {}),
        branches: Object.values(branches ?? {}),
      }),
    )
  }

  private fire(target: ForwardTarget, runId: string): void {
    const namespace =
      target.kind === "task" ? this.env.TASK_DO : this.env.AGENT_DO
    const name =
      target.kind === "task"
        ? `task:${runId}:${target.taskId}`
        : `agent:${runId}:${target.agentId}`
    const path = target.kind === "task" ? "/transition" : `/${target.endpoint}`
    const body =
      target.kind === "task" ? { status: target.status } : target.body
    const stub = namespace.get(namespace.idFromName(name))
    void stub
      .fetch(`http://do${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      })
      .catch(() => {})
  }
}
