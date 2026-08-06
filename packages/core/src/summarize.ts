// Run status DTO mapper — pure: a raw run snapshot in, a RunStatusSummary
// (M3) out. The snapshot shape is typed loosely here on purpose so the brain's
// raw run-state internals can evolve without breaking the MCP run_status tool.

import type { RunStatusSummary } from "@hamilton/shared"

export interface TaskStateLike {
  id: string
  status: string
  role: string
  branch?: string
  reviewRetries?: number
  prVerification?: {
    verified: boolean
    reason?: string
  }
}

export interface AgentStateLike {
  agentId: string
  taskId?: string
  state: string
  lastPhase?: string
  lastMessage?: string
  lastActivityAt?: string
  heartbeatAt?: string
  lastReportAt?: string
  claimedAt?: string
  startedAt?: string
  errorCount?: number
  subagentCount?: number
  lastReadyAt?: string
}

/** The slice of brain.readRunState the summary needs (arrays as persisted). */
export interface RunSnapshotLike {
  runId: string
  phase: string
  seq: number
  updatedAt?: string
  parent?: string
  tasks: TaskStateLike[]
  agents: AgentStateLike[]
}

const PROGRESS_BUCKETS: Record<string, keyof RunStatusSummary["progress"]> = {
  planned: "planned",
  "in-progress": "inProgress",
  reviewing: "reviewing",
  approved: "approved",
  merged: "merged",
  blocked: "blocked",
}

/** Unknown statuses (e.g. ready-for-review, optional) count as in-progress. */
function progressBucket(status: string): keyof RunStatusSummary["progress"] {
  return PROGRESS_BUCKETS[status] ?? "inProgress"
}

/** now - the newest of the agent's activity stamps (clamped at 0). */
function activityAgeMs(
  agent: AgentStateLike,
  nowMs: number,
): number | undefined {
  let latest = -Infinity
  let any = false
  for (const stamp of [
    agent.lastActivityAt,
    agent.heartbeatAt,
    agent.lastReportAt,
  ]) {
    if (stamp === undefined) continue
    const parsed = Date.parse(stamp)
    if (Number.isFinite(parsed)) {
      any = true
      if (parsed > latest) latest = parsed
    }
  }
  if (!any) return undefined
  return Math.max(0, nowMs - latest)
}

export function summarizeRun(
  snapshot: RunSnapshotLike,
  nowMs: number = Date.now(),
): RunStatusSummary {
  const tasks = snapshot.tasks ?? []
  const agents = snapshot.agents ?? []

  const progress: RunStatusSummary["progress"] = {
    planned: 0,
    inProgress: 0,
    reviewing: 0,
    approved: 0,
    merged: 0,
    blocked: 0,
  }
  for (const task of tasks) {
    progress[progressBucket(task.status)] += 1
  }

  const violations: RunStatusSummary["violations"] = []
  for (const task of tasks) {
    if (task.prVerification !== undefined && !task.prVerification.verified) {
      violations.push({
        taskId: task.id,
        kind: "pr-not-verified",
        detail: task.prVerification.reason ?? "PR missing or wrong base",
      })
    }
  }

  const summaryAgents: RunStatusSummary["agents"] = []
  for (const agent of agents) {
    const entry: RunStatusSummary["agents"][number] = {
      agentId: agent.agentId,
      state: agent.state,
    }
    if (agent.taskId !== undefined) entry.taskId = agent.taskId
    if (agent.lastPhase !== undefined) {
      entry.doing = {
        phase: agent.lastPhase,
        status: agent.state,
      }
      if (agent.lastMessage !== undefined)
        entry.doing.message = agent.lastMessage
    }
    const age = activityAgeMs(agent, nowMs)
    if (age !== undefined) entry.activityAgeMs = age
    entry.protocol = {
      claimed: agent.claimedAt !== undefined,
      started: agent.startedAt !== undefined,
      errors: agent.errorCount ?? 0,
      subagents: agent.subagentCount ?? 0,
      ready: agent.lastReadyAt !== undefined,
    }
    summaryAgents.push(entry)
  }

  const summaryTasks: RunStatusSummary["tasks"] = []
  for (const task of tasks) {
    const entry: RunStatusSummary["tasks"][number] = {
      id: task.id,
      status: task.status,
      role: task.role,
    }
    if (task.branch !== undefined) entry.branch = task.branch
    if (task.reviewRetries !== undefined)
      entry.reviewRetries = task.reviewRetries
    summaryTasks.push(entry)
  }

  return {
    runId: snapshot.runId,
    phase: snapshot.phase,
    seq: snapshot.seq,
    ...(snapshot.updatedAt !== undefined
      ? { updatedAt: snapshot.updatedAt }
      : {}),
    progress,
    agents: summaryAgents,
    tasks: summaryTasks,
    violations,
  }
}
