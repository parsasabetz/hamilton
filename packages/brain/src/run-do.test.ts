// Unit tests for the pure RunDO transition core.
// cloudflare:workers only exists inside workerd; bun:test mock.module provides a
// stand-in so run-do.ts can be loaded here at all.

import { describe, expect, mock, test } from "bun:test"

import type {
  HamiltonConfig,
  HamiltonEvent,
  ReviewFinding,
  ReviewSubmission,
  Task,
  TaskStatus,
} from "@hamilton/shared"
import type { AgentRunState, RunSnapshot, TaskRunState } from "./run-do.ts"

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    fetch() {
      return new Response("mock", { status: 404 })
    }
  },
}))

const {
  actionsFor,
  agentActivity,
  agentLogKey,
  applyEvent,
  decideGate,
  dispatchCandidates,
  extractBashCommand,
  findZoneViolation,
  forwardTargets,
  mergeTrigger,
  parseTask,
  parseTaskStatus,
  recordCommand,
  recordViolation,
  shouldMerge,
  shouldStop,
} = await import("./run-do.ts")

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
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
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
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
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
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
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
        t1: {
          id: "t1",
          status: "planned" as TaskStatus,
          role: "implementer",
          zone: [],
        },
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
        t1: {
          id: "t1",
          status: "ready-for-review" as TaskStatus,
          role: "",
          zone: [],
        },
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
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
      agents: {
        a1: {
          agentId: "a1",
          taskId: "t1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
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
      agents: {
        a1: {
          agentId: "a1",
          taskId: "t1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
    }
    const next = applyEvent(start, evt("agent.heartbeat", { agentId: "a1" }))
    expect(next.agents["a1"]?.heartbeatAt).toBe("2026-08-06T00:00:00.000Z")
  })

  test("agent.ready_for_review moves task and agent to ready", () => {
    const start = {
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
      agents: {
        a1: {
          agentId: "a1",
          taskId: "t1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
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
      agents: {
        a1: {
          agentId: "a1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
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
        t1: {
          id: "t1",
          status: "ready-for-review" as TaskStatus,
          role: "",
          zone: [],
        },
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
      tasks: {
        t1: { id: "t1", status: "reviewing" as TaskStatus, role: "", zone: [] },
      },
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
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
    }
    const next = {
      ...prev,
      tasks: {
        t1: { id: "t1", status: "blocked" as TaskStatus, role: "", zone: [] },
      },
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
      tasks: {
        t1: { id: "t1", status: "planned" as TaskStatus, role: "", zone: [] },
      },
    }
    const next = {
      ...prev,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
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
      agents: {
        a1: {
          agentId: "a1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
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
          zone: [],
        },
      },
      agents: {
        a1: {
          agentId: "a1",
          state: "started",
          failures: 0,
          zoneViolations: 0,
          milestoneCount: 0,
        },
      },
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
      tasks: {
        t1: { id: "t1", status: "planned" as TaskStatus, role: "", zone: [] },
      },
    }
    const next = applyEvent(start, evt("task.merged", { taskId: "t1" }))
    expect(next).not.toBe(start)
    expect(next.tasks).not.toBe(start.tasks)
    expect(start.tasks["t1"]?.status).toBe("planned")
  })
})

const agentState = (
  agentId: string,
  state: string,
  overrides: Partial<AgentRunState> = {},
): AgentRunState => ({
  agentId,
  state,
  failures: 0,
  zoneViolations: 0,
  milestoneCount: 0,
  ...overrides,
})

const iso = (ms: number): string => new Date(ms).toISOString()

const plannedTask = (id: string, dependsOn: string[] = []): TaskRunState => ({
  id,
  status: "planned" as TaskStatus,
  role: "implementer",
  zone: [],
  dependsOn,
})

const readyTask = (id: string, branch: string): TaskRunState => ({
  id,
  status: "ready-for-review" as TaskStatus,
  role: "implementer",
  zone: [],
  branch,
})

const approvedTask = (id: string, branch: string): TaskRunState => ({
  id,
  status: "approved" as TaskStatus,
  role: "implementer",
  zone: [],
  branch,
})

const testConfig = (
  earlyStop: HamiltonConfig["earlyStop"],
): HamiltonConfig => ({
  watchCommands: ["git"],
  zoneViolation: "record",
  earlyStop,
  eventRetry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
  leaseTtlMs: 60000,
  worktreesDir: ".worktrees",
  provision: { install: "auto" },
  activity: { windowMs: 120_000 },
  mergeAuthority: "owner-gated",
  review: {
    roles: ["correctness", "standards"],
    vetoRoles: ["*"],
    maxRetries: 2,
  },
})

const autonomousConfig = (): HamiltonConfig => ({
  ...testConfig({ enabled: false, maxFailedAgents: 2, failedRatio: 0.5 }),
  mergeAuthority: "autonomous",
})

const telemetry = (
  tool: string,
  input?: Record<string, unknown>,
  opencodeType = "session.next.tool.called",
): unknown => ({
  opencodeType,
  properties: { tool, ...(input !== undefined ? { input } : {}) },
})

describe("task.dispatched zones", () => {
  test("stores zone, branch and role from the payload", () => {
    const next = applyEvent(
      empty,
      evt("task.dispatched", {
        taskId: "t1",
        payload: {
          role: "implementer",
          branch: "feat/x",
          zone: ["packages/core/src"],
        },
      }),
    )
    expect(next.tasks["t1"]?.zone).toEqual(["packages/core/src"])
    expect(next.tasks["t1"]?.branch).toBe("feat/x")
    expect(next.tasks["t1"]?.role).toBe("implementer")
  })

  test("defaults zone to [] when the payload has none", () => {
    const next = applyEvent(
      empty,
      evt("task.dispatched", { taskId: "t1", payload: { role: "planner" } }),
    )
    expect(next.tasks["t1"]?.zone).toEqual([])
  })
})

describe("extractBashCommand", () => {
  test("detects a watched git command", () => {
    expect(
      extractBashCommand(telemetry("bash", { command: "git commit -m hi" }), [
        "git",
      ]),
    ).toEqual({ command: "git commit -m hi", matched: "git" })
  })

  test("returns null for non-bash tools", () => {
    expect(
      extractBashCommand(telemetry("edit", { filePath: "a.ts" }), ["git"]),
    ).toBeNull()
  })

  test("returns null for bash without a command", () => {
    expect(
      extractBashCommand(telemetry("bash", { timeout: 30 }), ["git"]),
    ).toBeNull()
    expect(extractBashCommand(telemetry("bash"), ["git"])).toBeNull()
  })

  test("reports an unmatched command with matched null", () => {
    expect(
      extractBashCommand(telemetry("bash", { command: "npm test" }), ["git"]),
    ).toEqual({ command: "npm test", matched: null })
  })
})

describe("findZoneViolation", () => {
  test("returns null for in-zone paths", () => {
    expect(
      findZoneViolation(
        telemetry("edit", { filePath: "packages/core/src/a.ts" }),
        ["packages/core/src"],
      ),
    ).toBeNull()
  })

  test("returns the path for out-of-zone edits", () => {
    expect(
      findZoneViolation(telemetry("write", { filePath: "lib/b.ts" }), [
        "packages/core/src",
      ]),
    ).toBe("lib/b.ts")
  })

  test("returns null when the zone is empty", () => {
    expect(
      findZoneViolation(telemetry("edit", { filePath: "lib/b.ts" }), []),
    ).toBeNull()
  })

  test("returns null for non-edit/write tools", () => {
    expect(
      findZoneViolation(telemetry("bash", { filePath: "x.ts" }), [
        "packages/core/src",
      ]),
    ).toBeNull()
  })
})

describe("recordCommand / recordViolation", () => {
  const start: RunSnapshot = {
    tasks: {
      t1: { id: "t1", status: "in-progress" as TaskStatus, role: "", zone: [] },
    },
    agents: {
      a1: agentState("a1", "working", { taskId: "t1" }),
    },
    phase: "running",
  }

  test("recordCommand sets lastCommand and tags the task", () => {
    const next = recordCommand(start, "a1", "git commit -m x", "git")
    expect(next.agents["a1"]?.lastCommand).toBe("git commit -m x")
    expect(next.tasks["t1"]?.lastEventType).toBe("agent.command")
  })

  test("recordCommand upserts an unknown agent without tagging a task", () => {
    const next = recordCommand(start, "ghost", "git status", "git")
    expect(next.agents["ghost"]?.lastCommand).toBe("git status")
    expect(next.agents["ghost"]?.failures).toBe(0)
    expect(next.tasks["t1"]?.lastEventType).toBeUndefined()
  })

  test("recordViolation increments zoneViolations", () => {
    const once = recordViolation(start, "a1", "lib/b.ts")
    expect(once.agents["a1"]?.zoneViolations).toBe(1)
    const twice = recordViolation(once, "a1", "lib/c.ts")
    expect(twice.agents["a1"]?.zoneViolations).toBe(2)
  })

  test("recordViolation upserts an unknown agent", () => {
    const next = recordViolation(start, "ghost", "lib/b.ts")
    expect(next.agents["ghost"]?.zoneViolations).toBe(1)
  })
})

describe("shouldStop", () => {
  test("false below both thresholds", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "died"),
        a2: agentState("a2", "working"),
        a3: agentState("a3", "working"),
      },
    }
    expect(
      shouldStop(
        snapshot,
        testConfig({ enabled: true, maxFailedAgents: 3, failedRatio: 0.5 }),
      ),
    ).toBe(false)
  })

  test("true at maxFailedAgents", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "died"),
        a2: agentState("a2", "error"),
        a3: agentState("a3", "working"),
      },
    }
    expect(
      shouldStop(
        snapshot,
        testConfig({ enabled: true, maxFailedAgents: 2, failedRatio: 0.9 }),
      ),
    ).toBe(true)
  })

  test("true at the failed ratio", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "died"),
        a2: agentState("a2", "working"),
      },
    }
    expect(
      shouldStop(
        snapshot,
        testConfig({ enabled: true, maxFailedAgents: 3, failedRatio: 0.5 }),
      ),
    ).toBe(true)
  })

  test("false when early stop is disabled", () => {
    const snapshot = {
      ...empty,
      agents: { a1: agentState("a1", "died") },
    }
    expect(
      shouldStop(
        snapshot,
        testConfig({ enabled: false, maxFailedAgents: 1, failedRatio: 0.1 }),
      ),
    ).toBe(false)
  })

  test("false for an empty run", () => {
    expect(
      shouldStop(
        empty,
        testConfig({ enabled: true, maxFailedAgents: 1, failedRatio: 0.1 }),
      ),
    ).toBe(false)
  })
})

describe("early stop transitions", () => {
  const cfg = testConfig({
    enabled: true,
    maxFailedAgents: 1,
    failedRatio: 0.5,
  })

  test("agent.error bumps failures and sets phase stopping", () => {
    const start = {
      ...empty,
      agents: { a1: agentState("a1", "working") },
    }
    const next = applyEvent(start, evt("agent.error", { agentId: "a1" }), cfg)
    expect(next.agents["a1"]?.state).toBe("error")
    expect(next.agents["a1"]?.failures).toBe(1)
    expect(next.phase).toBe("stopping")
  })

  test("agent.died bumps failures and sets phase stopping", () => {
    const start = {
      ...empty,
      agents: { a1: agentState("a1", "working") },
    }
    const next = applyEvent(start, evt("agent.died", { agentId: "a1" }), cfg)
    expect(next.agents["a1"]?.state).toBe("died")
    expect(next.agents["a1"]?.failures).toBe(1)
    expect(next.phase).toBe("stopping")
  })

  test("no stopping without a config", () => {
    const start = {
      ...empty,
      agents: { a1: agentState("a1", "working") },
    }
    expect(applyEvent(start, evt("agent.error", { agentId: "a1" })).phase).toBe(
      "planned",
    )
  })

  test("agent.claimed does not start planned tasks while stopping", () => {
    const start = {
      tasks: {
        t1: {
          id: "t1",
          status: "planned" as TaskStatus,
          role: "implementer",
          zone: [],
        },
      },
      agents: { a1: agentState("a1", "died", { failures: 1 }) },
      phase: "stopping",
    }
    const next = applyEvent(
      start,
      evt("agent.claimed", { taskId: "t1", agentId: "a2" }),
    )
    expect(next.tasks["t1"]?.status).toBe("planned")
    expect(next.agents["a2"]?.state).toBe("claimed")
  })

  test("milestones still record while stopping", () => {
    const start = {
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
      agents: { a1: agentState("a1", "started", { taskId: "t1" }) },
      phase: "stopping",
    }
    const next = applyEvent(start, evt("agent.milestone", { agentId: "a1" }))
    expect(next.agents["a1"]?.milestoneCount).toBe(1)
    expect(next.tasks["t1"]?.lastEventType).toBe("agent.milestone")
  })
})

describe("supervision state", () => {
  test("agent.milestone increments milestoneCount and moves started agents to working", () => {
    const start = { ...empty, agents: { a1: agentState("a1", "started") } }
    const first = applyEvent(start, evt("agent.milestone", { agentId: "a1" }))
    expect(first.agents["a1"]?.milestoneCount).toBe(1)
    expect(first.agents["a1"]?.state).toBe("working")
    const second = applyEvent(first, evt("agent.milestone", { agentId: "a1" }))
    expect(second.agents["a1"]?.milestoneCount).toBe(2)
    expect(second.agents["a1"]?.state).toBe("working")
  })

  test("agent.command records lastCommand defensively", () => {
    const start = { ...empty, agents: { a1: agentState("a1", "working") } }
    const next = applyEvent(
      start,
      evt("agent.command", {
        agentId: "a1",
        payload: { command: "git push", matched: "git" },
      }),
    )
    expect(next.agents["a1"]?.lastCommand).toBe("git push")
  })

  test("agent.zone_violation increments zoneViolations defensively", () => {
    const start = {
      ...empty,
      agents: { a1: agentState("a1", "working", { zoneViolations: 1 }) },
    }
    const next = applyEvent(
      start,
      evt("agent.zone_violation", {
        agentId: "a1",
        payload: { path: "lib/b.ts" },
      }),
    )
    expect(next.agents["a1"]?.zoneViolations).toBe(2)
  })
})

describe("agentLogKey", () => {
  test("pads seq and embeds the event id", () => {
    expect(agentLogKey("run-1", "a1", "milestones", 42, "evt-42")).toBe(
      "artifacts/run-1/agent-a1/milestones/0000000042-evt-42.json",
    )
    expect(agentLogKey("run-1", "a2", "reports", 7)).toMatch(
      /^artifacts\/run-1\/agent-a2\/reports\/0000000007-\d+\.json$/,
    )
  })
})

describe("agentActivity", () => {
  const WINDOW = 120_000
  const t0 = Date.parse("2026-08-06T00:00:00.000Z")

  test("recent activity → active", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", { lastActivityAt: iso(t0 + 60_000) }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + 120_000, WINDOW)).toBe("active")
  })

  test("stale past the window → idle", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", { lastActivityAt: iso(t0) }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + 130_000, WINDOW)).toBe("idle")
  })

  test("window boundary: == windowMs active, windowMs + 1 idle", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", { lastActivityAt: iso(t0) }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + WINDOW, WINDOW)).toBe("active")
    expect(agentActivity(snapshot, "a1", t0 + WINDOW + 1, WINDOW)).toBe("idle")
  })

  test("stalledAt set → stalled", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", {
          lastActivityAt: iso(t0),
          stalledAt: iso(t0 + 60_000),
        }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + 130_000, WINDOW)).toBe("stalled")
  })

  test("fresh activity beats a stale stalledAt marker", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", {
          lastActivityAt: iso(t0 + 100_000),
          stalledAt: iso(t0),
        }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + 110_000, WINDOW)).toBe("active")
  })

  test("silence past 3× the window → stalled even without stalledAt", () => {
    const snapshot = {
      ...empty,
      agents: {
        a1: agentState("a1", "working", { lastActivityAt: iso(t0) }),
      },
    }
    expect(agentActivity(snapshot, "a1", t0 + 3 * WINDOW + 1, WINDOW)).toBe(
      "stalled",
    )
  })

  test("died/error agents are always stalled", () => {
    const died = {
      ...empty,
      agents: {
        a1: agentState("a1", "died", { lastActivityAt: iso(t0 + 60_000) }),
      },
    }
    expect(agentActivity(died, "a1", t0 + 60_000, WINDOW)).toBe("stalled")
    const errored = {
      ...empty,
      agents: {
        a1: agentState("a1", "error", { lastActivityAt: iso(t0 + 60_000) }),
      },
    }
    expect(agentActivity(errored, "a1", t0 + 60_000, WINDOW)).toBe("stalled")
  })

  test("no timestamps at all → idle", () => {
    expect(agentActivity(empty, "ghost", t0, WINDOW)).toBe("idle")
    const bare = { ...empty, agents: { a1: agentState("a1", "working") } }
    expect(agentActivity(bare, "a1", t0, WINDOW)).toBe("idle")
  })

  test("heartbeatAt and the task's lastEventAt count as activity", () => {
    const beat = {
      ...empty,
      agents: { a1: agentState("a1", "working", { heartbeatAt: iso(t0) }) },
    }
    expect(agentActivity(beat, "a1", t0 + 60_000, WINDOW)).toBe("active")
    const viaTask = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          lastEventAt: iso(t0),
        },
      },
      agents: { a1: agentState("a1", "working", { taskId: "t1" }) },
    }
    expect(agentActivity(viaTask, "a1", t0 + 60_000, WINDOW)).toBe("active")
  })
})

describe("telemetry.opencode activity", () => {
  test("sessionId matching an agent sets lastActivityAt", () => {
    const start = { ...empty, agents: { a1: agentState("a1", "working") } }
    const next = applyEvent(
      start,
      evt("telemetry.opencode", {
        payload: {
          opencodeType: "session.next.tool.called",
          sessionId: "a1",
          properties: { tool: "edit", input: { filePath: "x.ts" } },
        },
      }),
    )
    expect(next.agents["a1"]?.lastActivityAt).toBe("2026-08-06T00:00:00.000Z")
  })

  test("unknown sessions leave the snapshot untouched", () => {
    const start = { ...empty, agents: { a1: agentState("a1", "working") } }
    const next = applyEvent(
      start,
      evt("telemetry.opencode", { payload: { sessionId: "ghost" } }),
    )
    expect(next).toBe(start)
  })

  test("agentId fallback works when the agent row exists", () => {
    const start = { ...empty, agents: { a1: agentState("a1", "working") } }
    const next = applyEvent(start, evt("telemetry.opencode", { agentId: "a1" }))
    expect(next.agents["a1"]?.lastActivityAt).toBe("2026-08-06T00:00:00.000Z")
  })
})

describe("run.planned seeding", () => {
  test("seeds tasks with status/zone/branch/dependsOn and run parent", () => {
    const next = applyEvent(
      empty,
      evt("run.planned", {
        payload: {
          parent: "main",
          tasks: [
            {
              id: "t1",
              status: "planned",
              role: "implementer",
              zone: ["packages/core/src"],
              branch: "feat/t1",
              depends_on: [],
            },
            {
              id: "t2",
              role: "reviewer",
              zone: ["packages/brain/src"],
              depends_on: ["t1"],
            },
          ],
        },
      }),
    )
    expect(next.phase).toBe("planned")
    expect(next.parent).toBe("main")
    expect(next.tasks["t1"]).toMatchObject({
      id: "t1",
      status: "planned",
      role: "implementer",
      zone: ["packages/core/src"],
      branch: "feat/t1",
      dependsOn: [],
    })
    expect(next.tasks["t2"]?.status).toBe("planned")
    expect(next.tasks["t2"]?.dependsOn).toEqual(["t1"])
  })

  test("refreshes existing rows without clobbering live fields", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "implementer",
          zone: [],
          lastEventAt: "2026-08-06T00:05:00.000Z",
        },
      },
    }
    const next = applyEvent(
      start,
      evt("run.planned", {
        payload: {
          tasks: [
            {
              id: "t1",
              status: "planned",
              role: "implementer",
              zone: ["packages/core/src"],
              depends_on: [],
            },
          ],
        },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("in-progress")
    expect(next.tasks["t1"]?.lastEventAt).toBe("2026-08-06T00:05:00.000Z")
    expect(next.tasks["t1"]?.zone).toEqual(["packages/core/src"])
    expect(next.tasks["t1"]?.dependsOn).toEqual([])
  })

  test("keeps rows not mentioned in the graph", () => {
    const start = {
      ...empty,
      tasks: {
        t9: { id: "t9", status: "merged" as TaskStatus, role: "", zone: [] },
      },
    }
    const next = applyEvent(start, evt("run.planned", { payload: {} }))
    expect(next.tasks["t9"]?.status).toBe("merged")
  })
})

describe("dispatchCandidates", () => {
  test("returns unblocked planned tasks in insertion order", () => {
    const snapshot = {
      ...empty,
      tasks: {
        t0: { id: "t0", status: "merged" as TaskStatus, role: "", zone: [] },
        t3: plannedTask("t3", ["t0"]),
        t1: plannedTask("t1"),
        t2: plannedTask("t2", ["t0"]),
      },
      phase: "running",
    }
    expect(dispatchCandidates(snapshot)).toEqual([
      { taskId: "t3" },
      { taskId: "t1" },
      { taskId: "t2" },
    ])
  })

  test("gates on merged dependencies", () => {
    const snapshot = {
      ...empty,
      tasks: {
        t0: {
          id: "t0",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
        t1: plannedTask("t1", ["t0"]),
        t2: plannedTask("t2", ["t0"]),
      },
      phase: "running",
    }
    expect(dispatchCandidates(snapshot)).toEqual([])
  })

  test("skips optional and non-planned tasks", () => {
    const snapshot = {
      ...empty,
      tasks: {
        t1: plannedTask("t1"),
        t2: { id: "t2", status: "optional" as TaskStatus, role: "", zone: [] },
        t3: {
          id: "t3",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
      phase: "running",
    }
    expect(dispatchCandidates(snapshot)).toEqual([{ taskId: "t1" }])
  })

  test("empty when the run is stopping", () => {
    const snapshot = {
      ...empty,
      tasks: { t1: plannedTask("t1") },
      phase: "stopping",
    }
    expect(dispatchCandidates(snapshot)).toEqual([])
  })
})

describe("shouldMerge / mergeTrigger", () => {
  const autonomous = autonomousConfig()
  const ownerGated = testConfig({
    enabled: false,
    maxFailedAgents: 2,
    failedRatio: 0.5,
  })

  test("autonomous + approved → merge with branch and parent", () => {
    const snapshot = {
      ...empty,
      parent: "main",
      tasks: { t1: approvedTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(shouldMerge(snapshot, "t1", autonomous)).toBe(true)
    expect(mergeTrigger(snapshot, autonomous)).toEqual([
      { taskId: "t1", branch: "feat/t1", parent: "main" },
    ])
  })

  test("autonomous + ready-for-review → no merge (the M3 gate replaced it)", () => {
    const snapshot = {
      ...empty,
      parent: "main",
      tasks: { t1: readyTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(shouldMerge(snapshot, "t1", autonomous)).toBe(false)
    expect(mergeTrigger(snapshot, autonomous)).toEqual([])
  })

  test("owner-gated → no merges", () => {
    const snapshot = {
      ...empty,
      parent: "main",
      tasks: { t1: approvedTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(shouldMerge(snapshot, "t1", ownerGated)).toBe(false)
    expect(mergeTrigger(snapshot, ownerGated)).toEqual([])
  })

  test("non-approved tasks are not merged", () => {
    const snapshot = {
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          branch: "feat/t1",
        },
      },
      phase: "running",
    }
    expect(shouldMerge(snapshot, "t1", autonomous)).toBe(false)
    expect(mergeTrigger(snapshot, autonomous)).toEqual([])
  })

  test("approved task without a branch is skipped", () => {
    const snapshot = {
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "approved" as TaskStatus,
          role: "",
          zone: [],
        },
      },
      phase: "running",
    }
    expect(mergeTrigger(snapshot, autonomous)).toEqual([])
  })

  test("no run parent → no merges", () => {
    const snapshot = {
      ...empty,
      tasks: { t1: approvedTask("t1", "feat/t1") },
    }
    expect(mergeTrigger(snapshot, autonomous)).toEqual([])
  })
})

describe("actionsFor", () => {
  const autonomous = autonomousConfig()

  test("worktree.ensure for planned, review.start for ready tasks", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: {
        t0: { id: "t0", status: "merged" as TaskStatus, role: "", zone: [] },
        t1: {
          id: "t1",
          status: "planned" as TaskStatus,
          role: "implementer",
          zone: [],
          branch: "feat/t1",
          dependsOn: ["t0"],
        },
        t2: {
          id: "t2",
          status: "ready-for-review" as TaskStatus,
          role: "implementer",
          zone: [],
          branch: "feat/t2",
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      {
        action: "worktree.ensure",
        runId: "run-1",
        taskId: "t1",
        parent: "main",
        branch: "feat/t1",
      },
      {
        action: "review.start",
        runId: "run-1",
        taskId: "t2",
        branch: "feat/t2",
        parent: "main",
        roles: ["correctness", "standards"],
        zone: [],
      },
    ])
  })

  test("branch defaults to feat/${taskId} and parent to empty", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "planned" as TaskStatus,
          role: "implementer",
          zone: [],
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      {
        action: "worktree.ensure",
        runId: "run-1",
        taskId: "t1",
        parent: "",
        branch: "feat/t1",
      },
    ])
  })

  test("nothing while stopping or finished", () => {
    const base = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "planned" as TaskStatus,
          role: "implementer",
          zone: [],
        },
      },
    }
    expect(actionsFor({ ...base, phase: "stopping" }, autonomous)).toEqual([])
    expect(actionsFor({ ...base, phase: "finished" }, autonomous)).toEqual([])
  })
})

describe("worktree events", () => {
  test("created registers a branch row", () => {
    const next = applyEvent(
      empty,
      evt("worktree.created", {
        payload: {
          branch: "feat/t1",
          parent: "main",
          worktreePath: ".worktrees/t1",
        },
      }),
    )
    expect(next.branches?.["feat/t1"]).toEqual({
      branch: "feat/t1",
      parent: "main",
      worktreePath: ".worktrees/t1",
    })
  })

  test("status_changed updates drift fields", () => {
    const created = applyEvent(
      empty,
      evt("worktree.created", {
        payload: { branch: "feat/t1", parent: "main" },
      }),
    )
    const next = applyEvent(
      created,
      evt("worktree.status_changed", {
        payload: {
          branch: "feat/t1",
          ahead: 2,
          behind: 0,
          dirtyCount: 1,
          unpushedCount: 3,
          commitCount: 5,
          merged: false,
          lastEventAt: "2026-08-06T00:01:00.000Z",
        },
      }),
    )
    expect(next.branches?.["feat/t1"]).toMatchObject({
      branch: "feat/t1",
      parent: "main",
      ahead: 2,
      behind: 0,
      dirtyCount: 1,
      unpushedCount: 3,
      commitCount: 5,
      merged: false,
      lastEventAt: "2026-08-06T00:01:00.000Z",
    })
  })

  test("removed deletes the row", () => {
    const created = applyEvent(
      empty,
      evt("worktree.created", {
        payload: { branch: "feat/t1", parent: "main" },
      }),
    )
    const removed = applyEvent(
      created,
      evt("worktree.removed", { payload: { branch: "feat/t1" } }),
    )
    expect(removed.branches?.["feat/t1"]).toBeUndefined()
  })

  test("git commits attribute activity to the branch's agent", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "implementer",
          zone: [],
          branch: "feat/t1",
        },
      },
      agents: {
        a1: agentState("a1", "working", { taskId: "t1" }),
        a2: agentState("a2", "working"),
      },
    }
    const created = applyEvent(
      start,
      evt("worktree.created", {
        payload: { branch: "feat/t1", parent: "main" },
      }),
    )
    const committed = applyEvent(
      created,
      evt("worktree.status_changed", {
        payload: { branch: "feat/t1", commitCount: 3 },
      }),
    )
    expect(committed.agents["a1"]?.lastActivityAt).toBe(
      "2026-08-06T00:00:00.000Z",
    )
    expect(committed.agents["a2"]?.lastActivityAt).toBeUndefined()
  })

  test("drift-only status_changed does not refresh activity", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "implementer",
          zone: [],
          branch: "feat/t1",
        },
      },
      agents: {
        a1: agentState("a1", "working", { taskId: "t1" }),
      },
    }
    const created = applyEvent(
      start,
      evt("worktree.created", {
        payload: { branch: "feat/t1", parent: "main" },
      }),
    )
    const once = applyEvent(
      created,
      evt("worktree.status_changed", {
        payload: { branch: "feat/t1", commitCount: 2 },
      }),
    )
    const firstActivity = once.agents["a1"]?.lastActivityAt
    expect(firstActivity).toBe("2026-08-06T00:00:00.000Z")
    const same = applyEvent(
      once,
      evt("worktree.status_changed", {
        ts: "2026-08-06T00:01:00.000Z",
        payload: { branch: "feat/t1", commitCount: 2 },
      }),
    )
    expect(same.agents["a1"]?.lastActivityAt).toBe(firstActivity)
    const more = applyEvent(
      same,
      evt("worktree.status_changed", {
        ts: "2026-08-06T00:02:00.000Z",
        payload: { branch: "feat/t1", commitCount: 5 },
      }),
    )
    expect(more.agents["a1"]?.lastActivityAt).toBe("2026-08-06T00:02:00.000Z")
  })

  test("malformed worktree events are no-ops", () => {
    const start = { ...empty, phase: "running" }
    expect(applyEvent(start, evt("worktree.created", { payload: {} }))).toBe(
      start,
    )
    expect(
      applyEvent(start, evt("worktree.status_changed", { payload: {} })),
    ).toBe(start)
    expect(applyEvent(start, evt("worktree.removed", { payload: {} }))).toBe(
      start,
    )
  })
})

describe("run finish transition", () => {
  test("task.merged sets phase finished when all tasks merged", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "merged" as TaskStatus, role: "", zone: [] },
        t2: {
          id: "t2",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
    }
    const next = applyEvent(start, evt("task.merged", { taskId: "t2" }))
    expect(next.tasks["t2"]?.status).toBe("merged")
    expect(next.phase).toBe("finished")
  })

  test("task.merged keeps the run running while tasks remain", () => {
    const start = {
      ...empty,
      tasks: {
        t1: { id: "t1", status: "merged" as TaskStatus, role: "", zone: [] },
        t2: {
          id: "t2",
          status: "ready-for-review" as TaskStatus,
          role: "",
          zone: [],
        },
      },
    }
    const next = applyEvent(start, evt("task.merged", { taskId: "t1" }))
    expect(next.phase).not.toBe("finished")
  })
})

const gateFinding = (id: string): ReviewFinding => ({
  id,
  location: "a.ts:1",
  issue: `issue ${id}`,
})

const gateSubmission = (
  reviewer: string,
  verdict: "pass" | "fail",
  findings: ReviewFinding[] = [],
): ReviewSubmission => ({ reviewer, idx: 0, verdict, findings })

describe("decideGate", () => {
  const gateConfig = (vetoRoles: string[]): HamiltonConfig => ({
    ...testConfig({ enabled: false, maxFailedAgents: 2, failedRatio: 0.5 }),
    review: {
      roles: ["correctness", "standards", "security"],
      vetoRoles,
      maxRetries: 2,
    },
  })

  test("all pass → pass; notes carry every reviewer's findings", () => {
    const decision = decideGate(
      [
        gateSubmission("correctness", "pass", [gateFinding("C-1")]),
        gateSubmission("standards", "pass", [gateFinding("S-1")]),
      ],
      gateConfig(["security"]),
    )
    expect(decision.verdict).toBe("pass")
    expect(decision.blockers).toEqual([])
    expect(decision.notes.map((n) => n.id)).toEqual(["C-1", "S-1"])
  })

  test("veto-role fail → fail with its findings as blockers", () => {
    const decision = decideGate(
      [
        gateSubmission("correctness", "pass", [gateFinding("C-1")]),
        gateSubmission("security", "fail", [gateFinding("SEC-1")]),
      ],
      gateConfig(["security"]),
    )
    expect(decision.verdict).toBe("fail")
    expect(decision.blockers.map((b) => b.id)).toEqual(["SEC-1"])
    expect(decision.notes.map((n) => n.id)).toEqual(["C-1"])
  })

  test("advisory (non-veto) fail plus passes → pass with notes", () => {
    const decision = decideGate(
      [
        gateSubmission("correctness", "fail", [gateFinding("C-1")]),
        gateSubmission("standards", "pass"),
        gateSubmission("security", "pass", [gateFinding("S-1")]),
      ],
      gateConfig(["security"]),
    )
    expect(decision.verdict).toBe("pass")
    expect(decision.blockers).toEqual([])
    expect(decision.notes.map((n) => n.id)).toEqual(["C-1", "S-1"])
  })

  test('"*" in vetoRoles makes every role veto', () => {
    const decision = decideGate(
      [gateSubmission("correctness", "fail", [gateFinding("C-1")])],
      gateConfig(["*"]),
    )
    expect(decision.verdict).toBe("fail")
    expect(decision.blockers.map((b) => b.id)).toEqual(["C-1"])
    expect(decision.notes).toEqual([])
  })

  test("no submissions → fail-closed", () => {
    expect(decideGate([], gateConfig(["security"]))).toEqual({
      verdict: "fail",
      blockers: [],
      notes: [],
    })
  })
})

describe("review gate applyEvent", () => {
  const cfg = testConfig({
    enabled: false,
    maxFailedAgents: 2,
    failedRatio: 0.5,
  })

  test("review.assigned stores reviewers + worktree path and moves to reviewing", () => {
    const next = applyEvent(
      empty,
      evt("review.assigned", {
        taskId: "t1",
        payload: {
          reviewers: [
            { idx: 0, role: "correctness", sessionId: "s0" },
            { idx: 1, role: "standards", sessionId: "s1" },
          ],
          worktreePath: ".worktrees/t1-review",
        },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("reviewing")
    expect(next.tasks["t1"]?.reviewers).toEqual([
      { idx: 0, role: "correctness", sessionId: "s0" },
      { idx: 1, role: "standards", sessionId: "s1" },
    ])
    expect(next.tasks["t1"]?.reviewWorktreePath).toBe(".worktrees/t1-review")
  })

  test("review.assigned accepts taskId from the payload", () => {
    const next = applyEvent(
      empty,
      evt("review.assigned", {
        payload: {
          taskId: "t1",
          reviewers: [{ idx: 0, role: "correctness" }],
        },
      }),
    )
    expect(next.tasks["t1"]?.status).toBe("reviewing")
    expect(next.tasks["t1"]?.reviewers).toEqual([
      { idx: 0, role: "correctness" },
    ])
  })

  test("review.submitted records the verdict and accumulates findings", () => {
    const assigned = applyEvent(
      empty,
      evt("review.assigned", {
        taskId: "t1",
        payload: {
          reviewers: [
            { idx: 0, role: "correctness", sessionId: "s0" },
            { idx: 1, role: "standards", sessionId: "s1" },
          ],
        },
      }),
    )
    const first = applyEvent(
      assigned,
      evt("review.submitted", {
        taskId: "t1",
        payload: {
          reviewer: "correctness",
          idx: 0,
          verdict: "pass",
          findings: [
            { id: "C-1", location: "a.ts:1", issue: "nit" },
            {
              id: "C-2",
              location: "b.ts:2",
              issue: "nit2",
              suggested_fix: "fix it",
            },
          ],
        },
      }),
    )
    expect(first.tasks["t1"]?.reviewers?.[0]).toMatchObject({
      idx: 0,
      role: "correctness",
      sessionId: "s0",
      verdict: "pass",
      submittedAt: "2026-08-06T00:00:00.000Z",
      findings: [
        { id: "C-1", location: "a.ts:1", issue: "nit" },
        {
          id: "C-2",
          location: "b.ts:2",
          issue: "nit2",
          suggested_fix: "fix it",
        },
      ],
    })
    expect(first.tasks["t1"]?.reviewFindings?.map((f) => f.id)).toEqual([
      "C-1",
      "C-2",
    ])
    const second = applyEvent(
      first,
      evt("review.submitted", {
        taskId: "t1",
        payload: {
          reviewer: "standards",
          idx: 1,
          verdict: "fail",
          findings: [{ id: "S-1", location: "c.ts:3", issue: "bad" }],
        },
      }),
    )
    expect(second.tasks["t1"]?.reviewers?.[1]?.verdict).toBe("fail")
    expect(second.tasks["t1"]?.reviewFindings?.map((f) => f.id)).toEqual([
      "C-1",
      "C-2",
      "S-1",
    ])
  })

  test("review.submitted falls back to the agent's task when taskId is absent", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "reviewing" as TaskStatus,
          role: "",
          zone: [],
          reviewers: [{ idx: 0, role: "correctness" }],
        },
      },
      agents: { a1: agentState("a1", "working", { taskId: "t1" }) },
    }
    const next = applyEvent(
      start,
      evt("review.submitted", {
        agentId: "a1",
        payload: {
          reviewer: "correctness",
          idx: 0,
          verdict: "pass",
          findings: [],
        },
      }),
    )
    expect(next.tasks["t1"]?.reviewers?.[0]?.verdict).toBe("pass")
  })

  test("review.verdict fail increments retries; at maxRetries blocks the task", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "reviewing" as TaskStatus,
          role: "",
          zone: [],
        },
      },
    }
    const once = applyEvent(
      start,
      evt("review.verdict", { taskId: "t1", payload: { verdict: "fail" } }),
      cfg,
    )
    expect(once.tasks["t1"]?.status).toBe("in-progress")
    expect(once.tasks["t1"]?.reviewRetries).toBe(1)
    const twice = applyEvent(
      once,
      evt("review.verdict", { taskId: "t1", payload: { verdict: "fail" } }),
      cfg,
    )
    expect(twice.tasks["t1"]?.reviewRetries).toBe(2)
    expect(twice.tasks["t1"]?.status).toBe("blocked")
  })

  test("review.verdict pass approves and keeps the accumulated findings", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "reviewing" as TaskStatus,
          role: "",
          zone: [],
          reviewFindings: [{ id: "C-1", location: "a.ts", issue: "nit" }],
        },
      },
    }
    const next = applyEvent(
      start,
      evt("review.verdict", { taskId: "t1", payload: { verdict: "pass" } }),
      cfg,
    )
    expect(next.tasks["t1"]?.status).toBe("approved")
    expect(next.tasks["t1"]?.reviewFindings).toEqual([
      { id: "C-1", location: "a.ts", issue: "nit" },
    ])
  })

  test("ready_for_review after a rejection clears the gate for a fresh round", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          reviewRetries: 1,
          reviewers: [
            {
              idx: 0,
              role: "correctness",
              verdict: "fail" as const,
              submittedAt: "x",
            },
          ],
          reviewFindings: [{ id: "S-1", location: "c.ts", issue: "bad" }],
          reviewWorktreePath: ".worktrees/t1-review",
        },
      },
      agents: { a1: agentState("a1", "started", { taskId: "t1" }) },
    }
    const next = applyEvent(
      start,
      evt("agent.ready_for_review", { agentId: "a1", taskId: "t1" }),
    )
    expect(next.tasks["t1"]?.status).toBe("ready-for-review")
    expect(next.tasks["t1"]?.reviewers).toBeUndefined()
    expect(next.tasks["t1"]?.reviewFindings).toBeUndefined()
    expect(next.tasks["t1"]?.reviewWorktreePath).toBeUndefined()
    expect(next.tasks["t1"]?.reviewRetries).toBe(1)
  })

  test("first ready_for_review leaves a task with no gate state untouched", () => {
    const start = {
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
        },
      },
    }
    const next = applyEvent(
      start,
      evt("agent.ready_for_review", { agentId: "a1", taskId: "t1" }),
    )
    expect(next.tasks["t1"]?.status).toBe("ready-for-review")
    expect(next.tasks["t1"]?.reviewRetries).toBeUndefined()
    expect(next.tasks["t1"]?.reviewers).toBeUndefined()
  })
})

describe("actionsFor review gating", () => {
  const autonomous = autonomousConfig()
  const ownerGated = testConfig({
    enabled: false,
    maxFailedAgents: 2,
    failedRatio: 0.5,
  })

  const reviewConfig = (model?: string): HamiltonConfig => ({
    ...autonomous,
    review: {
      roles: ["correctness", "standards"],
      vetoRoles: ["*"],
      maxRetries: 2,
      ...(model !== undefined ? { model } : {}),
    },
  })

  test("ready-for-review without reviewers issues review.start with roles/zone/parent", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "ready-for-review" as TaskStatus,
          role: "implementer",
          zone: ["packages/core/src"],
          branch: "feat/t1",
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, reviewConfig())).toEqual([
      {
        action: "review.start",
        runId: "run-1",
        taskId: "t1",
        branch: "feat/t1",
        parent: "main",
        roles: ["correctness", "standards"],
        zone: ["packages/core/src"],
      },
    ])
  })

  test("review.start carries the configured model when set", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "ready-for-review" as TaskStatus,
          role: "",
          zone: [],
          branch: "feat/t1",
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, reviewConfig("claude-sonnet"))).toEqual([
      {
        action: "review.start",
        runId: "run-1",
        taskId: "t1",
        branch: "feat/t1",
        parent: "main",
        roles: ["correctness", "standards"],
        model: "claude-sonnet",
        zone: [],
      },
    ])
  })

  test("ready-for-review with reviewers recorded does not re-issue review.start", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "ready-for-review" as TaskStatus,
          role: "",
          zone: [],
          branch: "feat/t1",
          reviewers: [{ idx: 0, role: "correctness" }],
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([])
  })

  test("approved + autonomous → merge.execute; ready-for-review never merges", () => {
    const approved = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: { t1: approvedTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(actionsFor(approved, autonomous)).toEqual([
      {
        action: "merge.execute",
        runId: "run-1",
        taskId: "t1",
        branch: "feat/t1",
        parent: "main",
      },
    ])
    const ready = { ...approved, tasks: { t1: readyTask("t1", "feat/t1") } }
    expect(
      actionsFor(ready, autonomous).some((a) => a.action === "merge.execute"),
    ).toBe(false)
  })

  test("approved + owner-gated → no merge", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: { t1: approvedTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(actionsFor(snapshot, ownerGated)).toEqual([])
  })

  test("in-progress after a rejection → session.nudge with rendered findings", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          reviewRetries: 1,
          reviewFindings: [
            {
              id: "SEC-1",
              location: "api/login.ts:42",
              issue: "missing validation",
              suggested_fix: "validate the input",
            },
            { id: "C-1", location: "a.ts:1", issue: "nit" },
          ],
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      {
        action: "session.nudge",
        runId: "run-1",
        taskId: "t1",
        message:
          "Review rejected (attempt 1). Findings:\n" +
          "- [SEC-1] api/login.ts:42: missing validation (suggested: validate the input)\n" +
          "- [C-1] a.ts:1: nit",
      },
    ])
  })

  test("nudge message caps findings at 20", () => {
    const findings = Array.from({ length: 25 }, (_, i) => ({
      id: `F-${i}`,
      location: "a.ts",
      issue: `issue ${i}`,
    }))
    const snapshot = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          reviewRetries: 1,
          reviewFindings: findings,
        },
      },
      phase: "running",
    }
    const actions = actionsFor(snapshot, autonomous)
    expect(actions).toHaveLength(1)
    const action = actions[0]
    if (action === undefined || action.action !== "session.nudge") {
      throw new Error("expected a session.nudge action")
    }
    const lines = action.message.split("\n")
    expect(lines).toHaveLength(21)
    expect(lines[1]).toBe("- [F-0] a.ts: issue 0")
    expect(lines[20]).toBe("- [F-19] a.ts: issue 19")
    expect(action.message).not.toContain("F-20")
  })

  test("no nudge when a rejected task has no findings", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "in-progress" as TaskStatus,
          role: "",
          zone: [],
          reviewRetries: 1,
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([])
  })

  test("approved with a review worktree → review.cleanup alongside the merge", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: {
        t1: {
          id: "t1",
          status: "approved" as TaskStatus,
          role: "",
          zone: [],
          branch: "feat/t1",
          reviewWorktreePath: ".worktrees/t1-review",
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      {
        action: "merge.execute",
        runId: "run-1",
        taskId: "t1",
        branch: "feat/t1",
        parent: "main",
      },
      { action: "review.cleanup", runId: "run-1", taskId: "t1" },
    ])
  })

  test("blocked with a review worktree → review.cleanup", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      tasks: {
        t1: {
          id: "t1",
          status: "blocked" as TaskStatus,
          role: "",
          zone: [],
          reviewWorktreePath: ".worktrees/t1-review",
        },
      },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      { action: "review.cleanup", runId: "run-1", taskId: "t1" },
    ])
  })

  test("approved without a review worktree gets no cleanup", () => {
    const snapshot = {
      runId: "run-1",
      ...empty,
      parent: "main",
      tasks: { t1: approvedTask("t1", "feat/t1") },
      phase: "running",
    }
    expect(actionsFor(snapshot, autonomous)).toEqual([
      {
        action: "merge.execute",
        runId: "run-1",
        taskId: "t1",
        branch: "feat/t1",
        parent: "main",
      },
    ])
  })
})
