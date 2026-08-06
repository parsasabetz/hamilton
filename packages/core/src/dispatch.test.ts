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
  buildReviewBrief,
  checkZoneCompliance,
  computeReadFacts,
  createDispatcher,
  createPermissionResponder,
  decidePermission,
  extractPermissionRequest,
  renderReadSummary,
  reviewWorktreePathFor,
} from "./dispatch.ts"
import type { ReadFacts } from "./dispatch.ts"
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
    async registryList(prefix: string): Promise<string[]> {
      return [...registry.keys()].filter((key) => key.startsWith(prefix))
    },
    async registryDelete(key: string): Promise<void> {
      registry.delete(key)
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

  test("session.nudge returns ok without a registered session", async () => {
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
      action: "session.nudge",
      runId: "run-1",
      taskId: "t1",
      message: "please continue",
    })
    expect(result).toEqual({ ok: true })
  })

  test("session.nudge returns ok with a registered mock session", async () => {
    const { bus } = stubBus()
    const { brain, registry } = stubBrain()
    registry.set("session:run-1:t1", "mock-t1")
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
      action: "session.nudge",
      runId: "run-1",
      taskId: "t1",
      message: "please continue",
    })
    expect(result).toEqual({ ok: true })
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

describe("checkZoneCompliance", () => {
  test("flags out-of-zone files and passes in-zone files", () => {
    const changed = [
      "src/a.ts",
      "src/lib/b.ts",
      "./src/c.ts",
      "docs/readme.md",
      "./docs/guide.md",
    ]
    expect(checkZoneCompliance(changed, ["src"])).toEqual([
      "docs/readme.md",
      "./docs/guide.md",
    ])
    expect(checkZoneCompliance(changed, ["src", "docs"])).toEqual([])
  })

  test("an empty zone never flags anything", () => {
    expect(checkZoneCompliance(["src/a.ts", "docs/readme.md"], [])).toEqual([])
  })
})

describe("computeReadFacts", () => {
  test("reads diff stat, changed files, and commits from a real repo", () => {
    const { repoRoot, worktreesDir } = makeRepo()
    run(["checkout", "-b", "feat/t1"], repoRoot)
    writeFileSync(join(repoRoot, "f1.txt"), "f1\n")
    run(["add", "f1.txt"], repoRoot)
    run(["commit", "-m", "one"], repoRoot)
    writeFileSync(join(repoRoot, "f2.txt"), "f2\n")
    run(["add", "f2.txt"], repoRoot)
    run(["commit", "-m", "two"], repoRoot)

    const facts = computeReadFacts(
      { repoRoot, worktreesDir },
      "feat/t1",
      "parent",
    )
    expect(facts.diffStat).toContain("f1.txt")
    expect(facts.changedFiles).toEqual(["f1.txt", "f2.txt"])
    expect(facts.commits).toHaveLength(2)
    expect(facts.commits[0]).toContain("two")
  })

  test("returns empty facts for a missing branch, never throws", () => {
    const { repoRoot, worktreesDir } = makeRepo()
    const facts = computeReadFacts(
      { repoRoot, worktreesDir },
      "feat/nope",
      "parent",
    )
    expect(facts.diffStat).toBe("")
    expect(facts.changedFiles).toEqual([])
    expect(facts.commits).toEqual([])
  })
})

describe("buildReviewBrief", () => {
  test("is deterministic and includes role, task, zone, and READ summary", () => {
    const facts: ReadFacts = {
      diffStat: "src/a.ts | 3 ++-",
      changedFiles: ["src/a.ts"],
      commits: ["abc1230 feat: change a"],
      zoneViolations: [],
    }
    const readSummary = renderReadSummary(facts, ["src", "tests"])
    const brief = buildReviewBrief({
      taskId: "t1",
      branch: "feat/t1",
      parent: "parent",
      role: "security",
      worktreePath: "/tmp/repo/.worktrees/review-t1",
      zone: ["src", "tests"],
      instructions: "You are a **reviewer**. Check the diff. Never edit.",
      readSummary,
    })
    expect(brief).toContain("You are the security reviewer for task t1")
    expect(brief).toContain(
      "You are a **reviewer**. Check the diff. Never edit.",
    )
    expect(brief).toContain("- branch: feat/t1")
    expect(brief).toContain("- parent: parent")
    expect(brief).toContain("- worktree: /tmp/repo/.worktrees/review-t1")
    expect(brief).toContain("- zone: src, tests")
    expect(brief).toContain("## READ (deterministic facts)")
    expect(brief).toContain("src/a.ts")
    expect(brief).toContain("abc1230 feat: change a")
    expect(brief).toContain("submit_review")
  })
})

describe("createDispatcher — review actions (real repo)", () => {
  test("review.start provisions a detached worktree and assigns reviewers", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    run(["checkout", "-b", "feat/t1"], repoRoot)
    writeFileSync(join(repoRoot, "feature.txt"), "feature\n")
    run(["add", "feature.txt"], repoRoot)
    run(["commit", "-m", "feature work"], repoRoot)
    const branchTip = run(["rev-parse", "feat/t1"], repoRoot).stdout

    const { bus, events } = stubBus()
    const { brain, registry } = stubBrain()
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
      action: "review.start",
      runId: "run-1",
      taskId: "t1",
      branch: "feat/t1",
      parent: "parent",
      roles: ["correctness", "security"],
      zone: ["src"],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.reviewerSessionIds).toEqual([
      "mock-review-t1-0",
      "mock-review-t1-1",
    ])
    expect(result.reviewWorktreePath).toBe(
      join(repoRoot, ".worktrees", "review-t1"),
    )
    expect(run(["worktree", "list", "--porcelain"], repoRoot).stdout).toContain(
      join(repoRoot, ".worktrees", "review-t1"),
    )
    expect(
      run(["rev-parse", "HEAD"], join(repoRoot, ".worktrees", "review-t1"))
        .stdout,
    ).toBe(branchTip)

    const assigned = events.find((event) => event.type === "review.assigned")
    expect(assigned?.taskId).toBe("t1")
    expect(assigned?.payload).toEqual({
      taskId: "t1",
      reviewers: [
        { idx: 0, role: "correctness", sessionId: "mock-review-t1-0" },
        { idx: 1, role: "security", sessionId: "mock-review-t1-1" },
      ],
      worktreePath: join(repoRoot, ".worktrees", "review-t1"),
    })
    expect(registry.get("review:run-1:t1:0")).toBe("mock-review-t1-0")
    expect(registry.get("review:run-1:t1:1")).toBe("mock-review-t1-1")
  })

  test("review.start reuses an existing review worktree on re-run", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    run(["checkout", "-b", "feat/t1"], repoRoot)
    writeFileSync(join(repoRoot, "feature.txt"), "feature\n")
    run(["add", "feature.txt"], repoRoot)
    run(["commit", "-m", "feature work"], repoRoot)

    const { bus } = stubBus()
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
    const action = {
      action: "review.start",
      runId: "run-1",
      taskId: "t1",
      branch: "feat/t1",
      parent: "parent",
      roles: ["correctness"],
      zone: [],
    } satisfies import("@hamilton/shared").CoreAction
    const first = await dispatcher.handleAction(action)
    const second = await dispatcher.handleAction(action)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    const listing = run(["worktree", "list", "--porcelain"], repoRoot).stdout
    const matches = listing
      .split("\n")
      .filter((line) => line.includes("review-t1"))
    expect(matches).toHaveLength(1)
  })

  test("review.cleanup removes the worktree and registry keys", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    run(["checkout", "-b", "feat/t1"], repoRoot)
    writeFileSync(join(repoRoot, "feature.txt"), "feature\n")
    run(["add", "feature.txt"], repoRoot)
    run(["commit", "-m", "feature work"], repoRoot)

    const { bus } = stubBus()
    const { brain, registry } = stubBrain()
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
    const started = await dispatcher.handleAction({
      action: "review.start",
      runId: "run-1",
      taskId: "t1",
      branch: "feat/t1",
      parent: "parent",
      roles: ["correctness"],
      zone: [],
    })
    expect(started.ok).toBe(true)
    const result = await dispatcher.handleAction({
      action: "review.cleanup",
      runId: "run-1",
      taskId: "t1",
    })
    expect(result).toEqual({ ok: true })
    expect(
      run(["worktree", "list", "--porcelain"], repoRoot).stdout,
    ).not.toContain("review-t1")
    expect(registry.get("review:run-1:t1:0")).toBeUndefined()
  })

  test("review.cleanup returns ok when no worktree exists", async () => {
    const { repoRoot, worktreesDir } = makeRepo()
    const { bus } = stubBus()
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
      action: "review.cleanup",
      runId: "run-1",
      taskId: "t1",
    })
    expect(result).toEqual({ ok: true })
    expect(reviewWorktreePathFor({ repoRoot, worktreesDir }, "t1")).toBe(
      join(repoRoot, ".worktrees", "review-t1"),
    )
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
