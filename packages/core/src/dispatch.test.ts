import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hamiltonConfigSchema } from "@hamilton/shared"
import type { HamiltonEvent } from "@hamilton/shared"
import type { BusHandle, EmitInput } from "./eventbus.ts"
import { parentHead } from "./git.ts"
import type { ControlPlane } from "./opencode.ts"
import {
  createDispatcher,
  createPermissionResponder,
  decidePermission,
  extractPermissionRequest,
} from "./dispatch.ts"
import type { DispatcherBrain } from "./dispatch.ts"

const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function stampEvent(input: EmitInput, seq: number): HamiltonEvent {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    ts: new Date().toISOString(),
    runId: input.runId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    seq,
    payload: input.payload,
  }
}

function stubBus(): { bus: BusHandle; events: HamiltonEvent[] } {
  const events: HamiltonEvent[] = []
  return {
    events,
    bus: {
      async emit(input) {
        const event = stampEvent(input, events.length + 1)
        events.push(event)
        return event
      },
      subscribe() {
        return () => {}
      },
      async tail() {
        return [...events]
      },
      stamp: stampEvent,
    },
  }
}

function stubBrain(): {
  brain: DispatcherBrain
  registry: Map<string, string>
} {
  const registry = new Map<string, string>()
  const brain = {
    async registryGet(key: string): Promise<string | null> {
      return registry.get(key) ?? null
    },
    async registryPut(key: string, value: string): Promise<void> {
      registry.set(key, value)
    },
  } as unknown as DispatcherBrain
  return { brain, registry }
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

function run(args: string[], cwd: string): GitResult {
  const res = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString().trim(),
    stderr: res.stderr.toString().trim(),
  }
}

function makeRepo(): { repoRoot: string; worktreesDir: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "hamilton-dispatch-"))
  cleanup.push(repoRoot)
  run(["init", "-b", "main"], repoRoot)
  run(["config", "user.email", "test@example.com"], repoRoot)
  run(["config", "user.name", "Hamilton Test"], repoRoot)
  writeFileSync(join(repoRoot, "a.txt"), "a\n")
  run(["add", "a.txt"], repoRoot)
  run(["commit", "-m", "a"], repoRoot)
  run(["checkout", "-b", "parent"], repoRoot)
  writeFileSync(join(repoRoot, "b.txt"), "b\n")
  run(["add", "b.txt"], repoRoot)
  run(["commit", "-m", "b"], repoRoot)
  return { repoRoot, worktreesDir: ".worktrees" }
}

function skipInstallConfig() {
  return hamiltonConfigSchema.parse({ provision: { install: "skip" } })
}

describe("decidePermission", () => {
  test("implementer may edit and run non-dangerous git", () => {
    expect(decidePermission("implementer", "edit", {}).allow).toBe(true)
    expect(
      decidePermission("implementer", "bash", { command: "git commit -m x" })
        .allow,
    ).toBe(true)
  })

  test("implementer is denied dangerous git commands", () => {
    expect(
      decidePermission("implementer", "bash", {
        command: "git push --force origin",
      }),
    ).toEqual({ allow: false, reason: "dangerous git" })
    expect(
      decidePermission("implementer", "bash", { command: "git rebase main" })
        .allow,
    ).toBe(false)
  })

  test("implementer is denied unknown tools", () => {
    expect(decidePermission("implementer", "rm", {}).allow).toBe(false)
  })

  test("reviewer may diff and test but not edit", () => {
    expect(
      decidePermission("reviewer", "bash", { command: "git diff" }).allow,
    ).toBe(true)
    expect(
      decidePermission("reviewer", "bash", { command: "pnpm test" }).allow,
    ).toBe(true)
    expect(decidePermission("reviewer", "edit", {}).allow).toBe(false)
  })

  test("planner is denied bash and edit", () => {
    expect(
      decidePermission("planner", "bash", { command: "git log" }).allow,
    ).toBe(false)
    expect(decidePermission("planner", "edit", {}).allow).toBe(false)
    expect(decidePermission("planner", "read", {}).allow).toBe(true)
  })

  test("unknown role denies everything", () => {
    expect(decidePermission("admin", "read", {}).allow).toBe(false)
    expect(
      decidePermission("admin", "bash", { command: "git diff" }).allow,
    ).toBe(false)
  })
})

describe("extractPermissionRequest", () => {
  test("parses a real permission.v2.asked payload", () => {
    const payload = {
      eventId: "evt-1",
      opencodeType: "permission.v2.asked",
      sessionId: "sess-1",
      properties: {
        id: "req-1",
        sessionID: "sess-1",
        action: "bash",
        resources: ["git push --force origin"],
        source: { type: "tool", messageID: "m-1", callID: "c-1" },
      },
    }
    expect(extractPermissionRequest(payload)).toEqual({
      sessionID: "sess-1",
      requestID: "req-1",
      tool: "bash",
      input: {
        command: "git push --force origin",
        resources: ["git push --force origin"],
      },
    })
  })

  test("returns null for a non-permission telemetry type", () => {
    expect(
      extractPermissionRequest({
        eventId: "evt-2",
        opencodeType: "session.idle",
        properties: { sessionID: "sess-1" },
      }),
    ).toBeNull()
  })

  test("returns null when fields are missing", () => {
    expect(
      extractPermissionRequest({
        opencodeType: "permission.v2.asked",
        properties: { id: "req-1", action: "bash" },
      }),
    ).toBeNull()
    expect(extractPermissionRequest(null)).toBeNull()
  })
})

describe("createDispatcher — session actions (mock mode)", () => {
  test("session.start dispatches a mock session and registers it", async () => {
    const { bus, events } = stubBus()
    const { brain, registry } = stubBrain()
    const dispatcher = createDispatcher({
      runId: "run-1",
      repoRoot: "/tmp/unused",
      worktreesDir: ".worktrees",
      parent: "main",
      config: hamiltonConfigSchema.parse({}),
      bus,
      brain,
      controlPlane: undefined,
    })
    const result = await dispatcher.handleAction({
      action: "session.start",
      runId: "run-1",
      taskId: "t1",
      agent: "implementer",
      model: "x/y",
      brief: "do the thing",
    })
    expect(result).toEqual({ ok: true, sessionId: "mock-t1" })
    expect(registry.get("session:run-1:t1")).toBe("mock-t1")
    const dispatched = events.find((event) => event.type === "task.dispatched")
    expect(dispatched?.payload).toEqual({
      sessionId: "mock-t1",
      branch: "feat/t1",
    })
  })

  test("session.abort without a registered session fails", async () => {
    const { bus } = stubBus()
    const { brain } = stubBrain()
    const dispatcher = createDispatcher({
      runId: "run-1",
      repoRoot: "/tmp/unused",
      worktreesDir: ".worktrees",
      parent: "main",
      config: hamiltonConfigSchema.parse({}),
      bus,
      brain,
      controlPlane: undefined,
    })
    const result = await dispatcher.handleAction({
      action: "session.abort",
      runId: "run-1",
      taskId: "t1",
    })
    expect(result).toEqual({ ok: false, error: "no session registered" })
  })
})

describe("createDispatcher — git actions (real repo)", () => {
  test("worktree.ensure creates the branch and worktree", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    const { bus, events } = stubBus()
    const { brain } = stubBrain()
    const dispatcher = createDispatcher({
      runId: "run-1",
      repoRoot,
      worktreesDir,
      parent: "parent",
      config: skipInstallConfig(),
      bus,
      brain,
      controlPlane: undefined,
    })
    const result = await dispatcher.handleAction({
      action: "worktree.ensure",
      runId: "run-1",
      taskId: "t1",
      parent: "parent",
      branch: "feat/t1",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.worktreePath).toBe(join(repoRoot, ".worktrees", "t1"))
    expect(
      run(["rev-parse", "--verify", "refs/heads/feat/t1"], repoRoot).exitCode,
    ).toBe(0)
    const created = events.find((event) => event.type === "worktree.created")
    expect(created?.payload).toEqual({
      branch: "feat/t1",
      parent: "parent",
      worktreePath: join(repoRoot, ".worktrees", "t1"),
    })
  })

  test("merge.execute squashes the worktree branch into parent", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    const { bus, events } = stubBus()
    const { brain } = stubBrain()
    const dispatcher = createDispatcher({
      runId: "run-1",
      repoRoot,
      worktreesDir,
      parent: "parent",
      config: skipInstallConfig(),
      bus,
      brain,
      controlPlane: undefined,
    })
    const ensured = await dispatcher.handleAction({
      action: "worktree.ensure",
      runId: "run-1",
      taskId: "t1",
      parent: "parent",
      branch: "feat/t1",
    })
    if (!ensured.ok) throw new Error(ensured.error)
    const worktreePath = ensured.worktreePath
    if (worktreePath === undefined) throw new Error("no worktree path")
    writeFileSync(join(worktreePath, "feature.txt"), "feature\n")
    run(["add", "feature.txt"], worktreePath)
    run(["commit", "-m", "feature work"], worktreePath)

    const result = await dispatcher.handleAction({
      action: "merge.execute",
      runId: "run-1",
      taskId: "t1",
      branch: "feat/t1",
      parent: "parent",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    const options = { repoRoot, worktreesDir }
    expect(result.mergeCommit).toBe(parentHead(options, "parent"))
    const merged = events.find((event) => event.type === "task.merged")
    expect(merged?.payload).toEqual({ commit: result.mergeCommit })
    expect(events.some((event) => event.type === "worktree.created")).toBe(true)
  })
})

function telemetryEvent(
  type: string,
  properties: Record<string, unknown>,
): HamiltonEvent {
  return {
    id: "evt",
    type: "telemetry.opencode",
    ts: new Date().toISOString(),
    runId: "run-1",
    seq: 1,
    payload: { opencodeType: type, sessionId: "sess-1", properties },
  }
}

describe("createPermissionResponder", () => {
  test("rejects a dangerous git command on the control plane", async () => {
    const replies: unknown[] = []
    const fakePlane = {
      client: {
        v2: {
          session: {
            permission: {
              reply: async (params: unknown) => {
                replies.push(params)
                return {}
              },
            },
          },
        },
      },
    } as unknown as ControlPlane
    const responder = createPermissionResponder({ controlPlane: fakePlane })
    await responder.handleTelemetry(
      telemetryEvent("permission.v2.asked", {
        id: "req-1",
        sessionID: "sess-1",
        action: "bash",
        resources: ["git push --force origin"],
      }),
    )
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({
      sessionID: "sess-1",
      requestID: "req-1",
      reply: "reject",
      message: "dangerous git",
    })
  })

  test("allows read-only bash for a reviewer session", async () => {
    const replies: unknown[] = []
    const fakePlane = {
      client: {
        v2: {
          session: {
            permission: {
              reply: async (params: unknown) => {
                replies.push(params)
                return {}
              },
            },
          },
        },
      },
    } as unknown as ControlPlane
    const responder = createPermissionResponder({
      controlPlane: fakePlane,
      roleForSession: (sessionId) =>
        sessionId === "sess-1" ? "reviewer" : undefined,
    })
    await responder.handleTelemetry(
      telemetryEvent("permission.v2.asked", {
        id: "req-2",
        sessionID: "sess-1",
        action: "bash",
        resources: ["git diff"],
      }),
    )
    expect(replies).toEqual([
      { sessionID: "sess-1", requestID: "req-2", reply: "once" },
    ])
  })

  test("mock mode and non-permission events never throw", async () => {
    const responder = createPermissionResponder({ controlPlane: undefined })
    await responder.handleTelemetry(
      telemetryEvent("permission.v2.asked", {
        id: "req-3",
        sessionID: "sess-1",
        action: "edit",
        resources: ["a.txt"],
      }),
    )
    await responder.handleTelemetry(
      telemetryEvent("session.idle", { sessionID: "sess-1" }),
    )
    await responder.handleTelemetry({
      id: "evt-2",
      type: "worktree.created",
      ts: new Date().toISOString(),
      runId: "run-1",
      seq: 2,
      payload: {},
    })
  })
})
