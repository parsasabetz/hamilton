import { describe, expect, test } from "bun:test"

import { summarizeRun } from "./summarize.ts"
import type {
  AgentStateLike,
  RunSnapshotLike,
  TaskStateLike,
} from "./summarize.ts"

const NOW = Date.parse("2026-08-06T12:00:00.000Z")

function snapshot(overrides: Partial<RunSnapshotLike> = {}): RunSnapshotLike {
  return {
    runId: "run-1",
    phase: "running",
    seq: 7,
    tasks: [],
    agents: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskStateLike>): TaskStateLike {
  return { id: "t1", status: "planned", role: "implementer", ...overrides }
}

function agent(overrides: Partial<AgentStateLike>): AgentStateLike {
  return { agentId: "a1", state: "working", ...overrides }
}

describe("summarizeRun — empty snapshot", () => {
  test("maps run identity and zeroed progress", () => {
    const summary = summarizeRun(
      snapshot({ updatedAt: "2026-08-06T11:00:00.000Z" }),
      NOW,
    )
    expect(summary.runId).toBe("run-1")
    expect(summary.phase).toBe("running")
    expect(summary.seq).toBe(7)
    expect(summary.updatedAt).toBe("2026-08-06T11:00:00.000Z")
    expect(summary.progress).toEqual({
      planned: 0,
      inProgress: 0,
      reviewing: 0,
      approved: 0,
      merged: 0,
      blocked: 0,
    })
    expect(summary.agents).toEqual([])
    expect(summary.tasks).toEqual([])
    expect(summary.violations).toEqual([])
  })

  test("omits updatedAt when absent", () => {
    const summary = summarizeRun(snapshot(), NOW)
    expect(summary.updatedAt).toBeUndefined()
  })
})

describe("summarizeRun — progress buckets", () => {
  test("maps known statuses and counts unknown statuses as in-progress", () => {
    const summary = summarizeRun(
      snapshot({
        tasks: [
          task({ id: "t1", status: "planned" }),
          task({ id: "t2", status: "in-progress" }),
          task({ id: "t3", status: "reviewing" }),
          task({ id: "t4", status: "approved" }),
          task({ id: "t5", status: "merged" }),
          task({ id: "t6", status: "blocked" }),
          task({ id: "t7", status: "ready-for-review" }),
          task({ id: "t8", status: "weird" }),
        ],
      }),
      NOW,
    )
    expect(summary.progress).toEqual({
      planned: 1,
      inProgress: 3,
      reviewing: 1,
      approved: 1,
      merged: 1,
      blocked: 1,
    })
  })
})

describe("summarizeRun — agents", () => {
  test("maps full agent state: doing, activity, protocol, taskId", () => {
    const summary = summarizeRun(
      snapshot({
        agents: [
          agent({
            taskId: "t1",
            lastPhase: "working",
            lastMessage: "implementing contract",
            lastActivityAt: "2026-08-06T11:59:00.000Z",
            heartbeatAt: "2026-08-06T11:58:00.000Z",
            claimedAt: "2026-08-06T10:00:00.000Z",
            startedAt: "2026-08-06T10:05:00.000Z",
            errorCount: 2,
            subagentCount: 3,
            lastReadyAt: "2026-08-06T11:55:00.000Z",
          }),
        ],
      }),
      NOW,
    )
    expect(summary.agents).toHaveLength(1)
    const [entry] = summary.agents
    expect(entry).toMatchObject({
      agentId: "a1",
      taskId: "t1",
      state: "working",
      doing: {
        phase: "working",
        status: "working",
        message: "implementing contract",
      },
      protocol: {
        claimed: true,
        started: true,
        errors: 2,
        subagents: 3,
        ready: true,
      },
    })
    expect(entry?.activityAgeMs).toBe(60_000)
  })

  test("activityAgeMs uses the newest stamp (heartbeat beats activity)", () => {
    const summary = summarizeRun(
      snapshot({
        agents: [
          agent({
            lastActivityAt: "2026-08-06T11:00:00.000Z",
            heartbeatAt: "2026-08-06T11:59:30.000Z",
            lastReportAt: "2026-08-06T10:30:00.000Z",
          }),
        ],
      }),
      NOW,
    )
    expect(summary.agents[0]?.activityAgeMs).toBe(30_000)
  })

  test("activityAgeMs with injected now and clamping", () => {
    const later = NOW + 120_000
    const summary = summarizeRun(
      snapshot({
        agents: [
          agent({ lastActivityAt: "2026-08-06T11:58:00.000Z" }),
          agent({
            agentId: "a2",
            state: "idle",
            lastReportAt: "2026-08-06T12:02:00.000Z",
          }),
        ],
      }),
      later,
    )
    expect(summary.agents[0]?.activityAgeMs).toBe(240_000)
    expect(summary.agents[1]?.activityAgeMs).toBe(0)
  })

  test("omits doing when lastPhase absent; protocol defaults on bare agents", () => {
    const summary = summarizeRun(
      snapshot({ agents: [agent({ state: "died" })] }),
      NOW,
    )
    expect(summary.agents[0]).toMatchObject({
      agentId: "a1",
      state: "died",
      protocol: {
        claimed: false,
        started: false,
        errors: 0,
        subagents: 0,
        ready: false,
      },
    })
    expect(summary.agents[0]?.doing).toBeUndefined()
    expect(summary.agents[0]?.activityAgeMs).toBeUndefined()
  })
})

describe("summarizeRun — tasks and violations", () => {
  test("maps task fields incl. branch and reviewRetries", () => {
    const summary = summarizeRun(
      snapshot({
        tasks: [
          task({
            id: "t1",
            status: "merged",
            role: "docs",
            branch: "feat/t1",
            reviewRetries: 1,
          }),
          task({ id: "t2", status: "planned", role: "implementer" }),
        ],
      }),
      NOW,
    )
    expect(summary.tasks).toEqual([
      {
        id: "t1",
        status: "merged",
        role: "docs",
        branch: "feat/t1",
        reviewRetries: 1,
      },
      { id: "t2", status: "planned", role: "implementer" },
    ])
  })

  test("flags unverified prVerification with reason detail", () => {
    const summary = summarizeRun(
      snapshot({
        tasks: [
          task({
            id: "t1",
            prVerification: { verified: false, reason: "checks failed" },
          }),
        ],
      }),
      NOW,
    )
    expect(summary.violations).toEqual([
      { taskId: "t1", kind: "pr-not-verified", detail: "checks failed" },
    ])
  })

  test("unverified prVerification without reason uses the default detail", () => {
    const summary = summarizeRun(
      snapshot({
        tasks: [task({ id: "t1", prVerification: { verified: false } })],
      }),
      NOW,
    )
    expect(summary.violations).toEqual([
      {
        taskId: "t1",
        kind: "pr-not-verified",
        detail: "PR missing or wrong base",
      },
    ])
  })

  test("verified or absent prVerification produces no violations", () => {
    const summary = summarizeRun(
      snapshot({
        tasks: [
          task({ id: "t1", prVerification: { verified: true, reason: "ok" } }),
          task({ id: "t2" }),
        ],
      }),
      NOW,
    )
    expect(summary.violations).toEqual([])
  })
})
