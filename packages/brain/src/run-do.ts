// Hamilton Brain — RunDO: per-run orchestrator state machine (HAMILTON.md §5).
//
// KV layout:
//   REGISTRY:
//     state:${runId}:run               — run snapshot { runId, phase, seq, updatedAt, tasks[], agents[] }
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
  HamiltonConfig,
  HamiltonEvent,
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
  lastSeq: "lastSeq",
  lastEventId: "lastEventId",
} as const

const DEDUPE_TTL_SECONDS = 86_400

export interface TaskRunState {
  id: string
  status: TaskStatus
  role: string
  branch?: string
  zone: string[]
  lastEventType?: string
  lastEventAt?: string
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
}

export interface RunSnapshot {
  tasks: Record<string, TaskRunState>
  agents: Record<string, AgentRunState>
  phase: string
}

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
    case "run.planned":
      return { ...snapshot, phase: "planned" }
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
      return taskId === undefined
        ? snapshot
        : withTaskStatus(snapshot, taskId, "merged")
    }
    case "task.escalated":
    case "task.blocked": {
      const taskId = evt.taskId
      return taskId === undefined
        ? snapshot
        : withTaskStatus(snapshot, taskId, "blocked")
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
      if (agentId !== undefined) {
        next = patchAgent(next, agentId, { state: "ready-for-review" })
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
      const failures = (snapshot.agents[agentId]?.failures ?? 0) + 1
      let next = patchAgent(snapshot, agentId, { state: "error", failures })
      if (config !== undefined && shouldStop(next, config)) {
        next = { ...next, phase: "stopping" }
      }
      return next
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
    case "review.assigned":
    case "review.started": {
      const taskId = evt.taskId
      return taskId === undefined
        ? snapshot
        : withTaskStatus(snapshot, taskId, "reviewing")
    }
    case "review.verdict": {
      const taskId = evt.taskId
      if (taskId === undefined) return snapshot
      return withTaskStatus(
        snapshot,
        taskId,
        payload.verdict === "pass" ? "approved" : "in-progress",
      )
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
      const [tasks, agents, phase, lastSeq] = await Promise.all([
        this.ctx.storage.get<Record<string, TaskRunState>>(KEYS.tasks),
        this.ctx.storage.get<Record<string, AgentRunState>>(KEYS.agents),
        this.ctx.storage.get<string>(KEYS.phase),
        this.ctx.storage.get<number>(KEYS.lastSeq),
      ])
      return Response.json({
        runId: this.runId(),
        phase: phase ?? "planned",
        seq: lastSeq ?? 0,
        updatedAt: new Date().toISOString(),
        tasks: Object.values(tasks ?? {}),
        agents: Object.values(agents ?? {}),
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

    const [graph, tasks, agents, phase] = await Promise.all([
      this.ctx.storage.get<Task[]>(KEYS.graph),
      this.ctx.storage.get<Record<string, TaskRunState>>(KEYS.tasks),
      this.ctx.storage.get<Record<string, AgentRunState>>(KEYS.agents),
      this.ctx.storage.get<string>(KEYS.phase),
    ])
    const snapshot: RunSnapshot = {
      tasks: tasks ?? {},
      agents: agents ?? {},
      phase: phase ?? "planned",
    }
    const supervised = this.supervise(evt, snapshot)
    const next = applyEvent(supervised, evt, this.config)
    this.logAgentArtifacts(evt)
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
        tasks: Object.values(next.tasks),
        agents: Object.values(next.agents),
      }),
    )
    for (const target of forwardTargets(snapshot, next, evt)) {
      this.fire(target, evt.runId)
    }
    return Response.json({ ok: true })
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
