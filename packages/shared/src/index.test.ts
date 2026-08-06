import { describe, expect, test } from "bun:test"
import { hamiltonConfigSchema, taskGraphSchema, taskSchema } from "./index.ts"

const validTask = {
  id: "t1",
  role: "implementer",
  zone: ["packages/core/src"],
  depends_on: [],
  status: "planned",
  on_failure: "retry-once",
  contract: {
    inputs: ["doc §1"],
    outputs: ["feature"],
  },
  model: "opencode-go/deepseek-v4-flash",
}

describe("taskSchema", () => {
  test("accepts a valid task", () => {
    const parsed = taskSchema.safeParse(validTask)
    expect(parsed.success).toBe(true)
    expect(parsed.data?.allowed_subagents).toEqual([])
  })

  test("rejects an unknown status", () => {
    const result = taskSchema.safeParse({ ...validTask, status: "done" })
    expect(result.success).toBe(false)
  })

  test("rejects a missing contract output", () => {
    const result = taskSchema.safeParse({
      ...validTask,
      contract: { inputs: ["doc §1"] },
    })
    expect(result.success).toBe(false)
  })

  test("accepts optional fields", () => {
    const parsed = taskSchema.safeParse({
      ...validTask,
      budget_cap: 2.5,
      branch: "feat/t1",
      pr_title: "feat(t1): do the thing",
    })
    expect(parsed.success).toBe(true)
  })
})

describe("hamiltonConfigSchema", () => {
  test("defaults apply when parsing an empty object", () => {
    const cfg = hamiltonConfigSchema.parse({})
    expect(cfg.watchCommands).toEqual(["git"])
    expect(cfg.zoneViolation).toBe("record")
    expect(cfg.earlyStop).toEqual({
      enabled: true,
      maxFailedAgents: 2,
      failedRatio: 0.5,
    })
    expect(cfg.eventRetry).toEqual({
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
    })
    expect(cfg.leaseTtlMs).toBe(60_000)
  })

  test("overrides merge onto defaults", () => {
    const cfg = hamiltonConfigSchema.parse({
      watchCommands: ["git", "npm"],
      earlyStop: { enabled: false, maxFailedAgents: 5, failedRatio: 0.3 },
    })
    expect(cfg.watchCommands).toEqual(["git", "npm"])
    expect(cfg.earlyStop).toEqual({
      enabled: false,
      maxFailedAgents: 5,
      failedRatio: 0.3,
    })
    expect(cfg.eventRetry.maxAttempts).toBe(3)
  })

  test("rejects invalid values", () => {
    expect(hamiltonConfigSchema.safeParse({ leaseTtlMs: -1 }).success).toBe(
      false,
    )
    expect(
      hamiltonConfigSchema.safeParse({
        earlyStop: { enabled: true, maxFailedAgents: 0, failedRatio: 0.5 },
      }).success,
    ).toBe(false)
    expect(
      hamiltonConfigSchema.safeParse({
        earlyStop: { enabled: true, maxFailedAgents: 2, failedRatio: 1.5 },
      }).success,
    ).toBe(false)
  })
})

describe("taskGraphSchema", () => {
  const validTask = {
    id: "t1",
    role: "implementer",
    zone: ["packages/core/src"],
    depends_on: [],
    status: "planned",
    on_failure: "retry-once",
    contract: { inputs: ["doc §1"], outputs: ["feature"] },
    model: "opencode-go/deepseek-v4-flash",
  }

  test("accepts a graph with one or more tasks", () => {
    expect(taskGraphSchema.safeParse({ tasks: [validTask] }).success).toBe(true)
    expect(
      taskGraphSchema.safeParse({
        tasks: [validTask, { ...validTask, id: "t2", depends_on: ["t1"] }],
        meta: { prompt: "build an app" },
      }).success,
    ).toBe(true)
  })

  test("rejects an empty or invalid graph", () => {
    expect(taskGraphSchema.safeParse({ tasks: [] }).success).toBe(false)
    expect(
      taskGraphSchema.safeParse({ tasks: [{ ...validTask, depends_on: "t2" }] })
        .success,
    ).toBe(false)
  })
})

describe("hamiltonConfigSchema M2 additions", () => {
  test("defaults for worktrees, provision, activity, mergeAuthority", () => {
    const cfg = hamiltonConfigSchema.parse({})
    expect(cfg.worktreesDir).toBe(".worktrees")
    expect(cfg.provision).toEqual({ install: "auto" })
    expect(cfg.activity).toEqual({ windowMs: 120_000 })
    expect(cfg.mergeAuthority).toBe("owner-gated")
  })

  test("accepts M2 overrides", () => {
    const cfg = hamiltonConfigSchema.parse({
      worktreesDir: "../wt",
      provision: { install: "skip" },
      activity: { windowMs: 60_000 },
      mergeAuthority: "autonomous",
    })
    expect(cfg.worktreesDir).toBe("../wt")
    expect(cfg.provision.install).toBe("skip")
    expect(cfg.activity.windowMs).toBe(60_000)
    expect(cfg.mergeAuthority).toBe("autonomous")
  })
})
