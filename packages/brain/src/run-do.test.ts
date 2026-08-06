// Unit tests for the pure RunDO transition core.
// cloudflare:workers only exists inside workerd; bun:test mock.module provides a
// stand-in so run-do.ts can be loaded here at all.

import { describe, expect, mock, test } from "bun:test"

import type { HamiltonEvent, Task, TaskStatus } from "@hamilton/shared"
import type { RunSnapshot } from "./run-do.ts"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    fetch() {
      return new Response("mock", { status: 404 })
    }
  },
}))

const { applyEvent, forwardTargets, parseTask, parseTaskStatus } =
  await import("./run-do.ts")

const empty: RunSnapshot = { tasks: {}, agents: {}, phase: "planned" }

let seq = 0
function evt(
  type: HamiltonEvent["type"],
  overrides: Partial<HamiltonEvent> = {},
): HamiltonEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    type,
    ts: "2026-08-06T00:00:00.000Z",
    runId: "run-1",
    seq,
    payload: {},
    ...overrides,
  }
}

describe("applyEvent", () => {
  test("run.planned sets phase", () => {
    const next = applyEvent(empty, evt("run.planned"))
    expect(next.phase).toBe("planned")
  })

  test("run.pause/resume/finish set phase", () => {
    expect(applyEvent(empty, evt("run.pause")).phase).toBe("paused")
    expect(applyEvent(empty, evt("run.resume")).phase).toBe("running")
    expect(applyEvent(empty, evt("run.finish")).phase).toBe("finished")
  })

  test("task.dispatched registers the task as in-progress", () => {
    const next = applyEvent(
      empty,
      evt("task.dispatched", {
        taskId: "t1",
        payload: { role: "implementer" },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("in-progress")
    expect(next.tasks["t1"]?.role).toBe("implementer")
  })

  test("task.dispatched without taskId is a no-op", () => {
    expect(applyEvent(empty, evt("task.dispatched"))).toBe(empty)
  })

  test("task.status_changed applies a valid status", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
    }
    const next = applyEvent(
      start,
      evt("task.status_changed", {
        taskId: "t1",
        payload: { status: "blocked" },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("blocked")
  })

  test("task.status_changed ignores an invalid status", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
    }
    const next = applyEvent(
      start,
      evt("task.status_changed", {
        taskId: "t1",
        payload: { status: "bogus" },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("in-progress")
  })

  test("task.merged/escalated/blocked set task status", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
    }
    expect(
      applyEvent(start, evt("task.merged", { taskId: "t1" })).tasks["t1"]
        ?.status,
    ).toBe("merged")
    expect(
      applyEvent(start, evt("task.escalated", { taskId: "t1" })).tasks["t1"]
        ?.status,
    ).toBe("blocked")
    expect(
      applyEvent(start, evt("task.blocked", { taskId: "t1" })).tasks["t1"]
        ?.status,
    ).toBe("blocked")
  })

  test("agent.claimed upserts the agent and moves a planned task to in-progress", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "planned" as TaskStatus, role: "implementer" },
      },
    }
    const next = applyEvent(
      start,
      evt("agent.claimed", { taskId: "t1", agentId: "a1" }),
    )
    expect(next.agents["a1"]?.state).toBe("claimed")
    expect(next.agents["a1"]?.taskId).toBe("t1")
    expect(next.tasks["t1"]?.status).toBe("in-progress")
  })

  test("agent.started sets state started but leaves a non-planned task alone", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "ready-for-review" as TaskStatus, role: "" },
      },
    }
    const next = applyEvent(
      start,
      evt("agent.started", { taskId: "t1", agentId: "a1" }),
    )
    expect(next.agents["a1"]?.state).toBe("started")
    expect(next.tasks["t1"]?.status).toBe("ready-for-review")
  })

  test("agent.milestone records agent activity and task last event", () => {
    const start = {
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
      agents: { a1: { agentId: "a1", taskId: "t1", state: "started" } },
      phase: "running",
    }
    const next = applyEvent(
      start,
      evt("agent.milestone", { agentId: "a1", taskId: "t1" }),
    )
    expect(next.agents["a1"]?.lastActivityAt).toBe("2026-08-06T00:00:00.000Z")
    expect(next.tasks["t1"]?.lastEventType).toBe("agent.milestone")
    expect(next.tasks["t1"]?.status).toBe("in-progress")
  })

  test("agent.heartbeat records heartbeatAt", () => {
    const start = {
      ...empty,
      agents: { a1: { agentId: "a1", taskId: "t1", state: "started" } },
    }
    const next = applyEvent(start, evt("agent.heartbeat", { agentId: "a1" }))
    expect(next.agents["a1"]?.heartbeatAt).toBe("2026-08-06T00:00:00.000Z")
  })

  test("agent.ready_for_review moves task and agent to ready", () => {
    const start = {
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
      agents: { a1: { agentId: "a1", taskId: "t1", state: "started" } },
      phase: "running",
    }
    const next = applyEvent(
      start,
      evt("agent.ready_for_review", { agentId: "a1", taskId: "t1" }),
    )
    expect(next.tasks["t1"]?.status).toBe("ready-for-review")
    expect(next.agents["a1"]?.state).toBe("ready-for-review")
  })

  test("agent liveness events update the agent", () => {
    const start = {
      ...empty,
      agents: { a1: { agentId: "a1", state: "started" } },
    }
    expect(
      applyEvent(start, evt("agent.stalled", { agentId: "a1" })).agents["a1"]
        ?.stalledAt,
    ).toBe("2026-08-06T00:00:00.000Z")
    expect(
      applyEvent(start, evt("agent.idle", { agentId: "a1" })).agents["a1"]
        ?.busy,
    ).toBe(false)
    expect(
      applyEvent(start, evt("agent.died", { agentId: "a1" })).agents["a1"]
        ?.diedAt,
    ).toBe("2026-08-06T00:00:00.000Z")
    expect(
      applyEvent(start, evt("agent.error", { agentId: "a1" })).agents["a1"]
        ?.state,
    ).toBe("error")
  })

  test("agent events for unknown agents register them defensively", () => {
    const beat = applyEvent(empty, evt("agent.heartbeat", { agentId: "ghost" }))
    expect(beat.agents["ghost"]).toBeDefined()
    expect(beat.agents["ghost"]?.heartbeatAt).toBeDefined()
    const milestone = applyEvent(
      empty,
      evt("agent.milestone", { agentId: "ghost", taskId: "t9" }),
    )
    expect(milestone.agents["ghost"]?.taskId).toBe("t9")
    expect(milestone.agents["ghost"]?.lastActivityAt).toBeDefined()
  })

  test("review.assigned/started move the task to reviewing", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "ready-for-review" as TaskStatus, role: "" },
      },
    }
    expect(
      applyEvent(start, evt("review.assigned", { taskId: "t1" })).tasks["t1"]
        ?.status,
    ).toBe("reviewing")
    expect(
      applyEvent(start, evt("review.started", { taskId: "t1" })).tasks["t1"]
        ?.status,
    ).toBe("reviewing")
  })

  test("review.verdict pass approves, anything else sends back to in-progress", () => {
    const start = {
      ...empty,
      tasks: { t1: { id: "t1", status: "reviewing" as TaskStatus, role: "" } },
    }
    expect(
      applyEvent(
        start,
        evt("review.verdict", { taskId: "t1", payload: { verdict: "pass" } }),
      ).tasks["t1"]?.status,
    ).toBe("approved")
    expect(
      applyEvent(
        start,
        evt("review.verdict", { taskId: "t1", payload: { verdict: "fail" } }),
      ).tasks["t1"]?.status,
    ).toBe("in-progress")
    expect(
      applyEvent(start, evt("review.verdict", { taskId: "t1", payload: {} }))
        .tasks["t1"]?.status,
    ).toBe("in-progress")
  })

  test("unhandled event types leave the snapshot untouched", () => {
    const start = { ...empty, phase: "running" }
    expect(applyEvent(start, evt("telemetry.opencode"))).toBe(start)
    expect(applyEvent(start, evt("agent.blocked", { agentId: "a1" }))).toBe(
      start,
    )
    expect(applyEvent(start, evt("system.error"))).toBe(start)
  })
})

describe("forwardTargets", () => {
  test("emits a task transition when task status changed", () => {
    const prev = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
    }
    const next = {
      ...prev,
      tasks: { t1: { id: "t1", status: "blocked" as TaskStatus, role: "" } },
    }
    const targets = forwardTargets(
      prev,
      next,
      evt("task.status_changed", {
        taskId: "t1",
        payload: { status: "blocked" },
      }),
    )
    expect(targets).toEqual([{ kind: "task", taskId: "t1", status: "blocked" }])
  })

  test("emits agent register for claimed/started", () => {
    const prev = {
      ...empty,
      tasks: { t1: { id: "t1", status: "planned" as TaskStatus, role: "" } },
    }
    const next = {
      ...prev,
      tasks: {
        t1: { id: "t1", status: "in-progress" as TaskStatus, role: "" },
      },
    }
    const targets = forwardTargets(
      prev,
      next,
      evt("agent.claimed", { taskId: "t1", agentId: "a1" }),
    )
    expect(targets).toContainEqual({
      kind: "task",
      taskId: "t1",
      status: "in-progress",
    })
    expect(targets).toContainEqual({
      kind: "agent",
      agentId: "a1",
      endpoint: "register",
      body: { taskId: "t1" },
    })
  })

  test("maps agent liveness events to endpoints", () => {
    const start = {
      ...empty,
      agents: { a1: { agentId: "a1", state: "started" } },
    }
    expect(
      forwardTargets(start, start, evt("agent.heartbeat", { agentId: "a1" })),
    ).toEqual([
      { kind: "agent", agentId: "a1", endpoint: "heartbeat", body: {} },
    ])
    expect(
      forwardTargets(start, start, evt("agent.died", { agentId: "a1" })),
    ).toEqual([{ kind: "agent", agentId: "a1", endpoint: "died", body: {} }])
  })

  test("telemetry events produce no forwards", () => {
    expect(forwardTargets(empty, empty, evt("telemetry.opencode"))).toEqual([])
  })
})

describe("parseTaskStatus", () => {
  test("accepts valid statuses, rejects garbage", () => {
    expect(parseTaskStatus("merged")).toBe("merged")
    expect(parseTaskStatus("bogus")).toBeUndefined()
    expect(parseTaskStatus(42)).toBeUndefined()
    expect(parseTaskStatus(undefined)).toBeUndefined()
  })
})

describe("parseTask", () => {
  const validTask: Task = {
    id: "t1",
    role: "implementer",
    zone: ["packages/core/src"],
    depends_on: [],
    status: "planned",
    on_failure: "retry-once",
    contract: { inputs: ["graph"], outputs: ["patch"] },
    model: "claude-opus",
    allowed_subagents: ["planner"],
  }

  test("parses a full task and preserves optional fields", () => {
    const parsed = parseTask({
      ...validTask,
      budget_cap: 50,
      branch: "feat/x",
      pr_title: "X",
    })
    expect(parsed).toEqual({
      ...validTask,
      budget_cap: 50,
      branch: "feat/x",
      pr_title: "X",
    })
  })

  test("rejects malformed tasks", () => {
    expect(parseTask({ ...validTask, status: "bogus" })).toBeUndefined()
    expect(
      parseTask({ ...validTask, contract: { inputs: [], outputs: [1] } }),
    ).toBeUndefined()
    expect(parseTask({ id: "t1" })).toBeUndefined()
    expect(parseTask(null)).toBeUndefined()
  })
})

describe("helpers", () => {
  test("run domain transitions keep other state intact", () => {
    const start: RunSnapshot = {
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "implementer",
        },
      },
      agents: { a1: { agentId: "a1", state: "started" } },
      phase: "running",
    }
    const next = applyEvent(start, evt("run.pause"))
    expect(next.tasks["t1"]?.status).toBe("in-progress")
    expect(next.agents["a1"]?.state).toBe("started")
    expect(next.phase).toBe("paused")
  })

  test("tasks is a fresh object each transition (pure)", () => {
    const start = {
      ...empty,
      tasks: { t1: { id: "t1", status: "planned" as TaskStatus, role: "" } },
    }
    const next = applyEvent(start, evt("task.merged", { taskId: "t1" }))
    expect(next).not.toBe(start)
    expect(next.tasks).not.toBe(start.tasks)
    expect(start.tasks["t1"]?.status).toBe("planned")
  })
})
