import { describe, expect, test } from "bun:test"
import {
  checkpointPhases,
  checkpointPhaseStatus,
  checkpointMatrixError,
  hamiltonConfigSchema,
  hamiltonToolNames,
  hamiltonToolSpecs,
  taskGraphSchema,
  taskSchema,
} from "./index.ts"

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
  const graphTask = {
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
        tasks: [validTask, { ...graphTask, id: "t2", depends_on: ["t1"] }],
        meta: { prompt: "build an app" },
      }).success,
    ).toBe(true)
  })

  test("rejects an empty or invalid graph", () => {
    expect(taskGraphSchema.safeParse({ tasks: [] }).success).toBe(false)
    expect(
      taskGraphSchema.safeParse({ tasks: [{ ...graphTask, depends_on: "t2" }] })
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

describe("hamiltonConfigSchema M3 review block", () => {
  test("defaults: two roles, all veto, 2 retries", () => {
    const cfg = hamiltonConfigSchema.parse({})
    expect(cfg.review).toEqual({
      roles: ["correctness", "standards"],
      vetoRoles: ["*"],
      maxRetries: 2,
    })
  })

  test("accepts role/veto overrides", () => {
    const cfg = hamiltonConfigSchema.parse({
      review: {
        roles: ["security", "correctness", "style"],
        vetoRoles: ["security"],
        maxRetries: 3,
        model: "opencode-go/deepseek-v4-flash",
      },
    })
    expect(cfg.review.vetoRoles).toEqual(["security"])
    expect(cfg.review.roles).toHaveLength(3)
    expect(cfg.review.model).toBe("opencode-go/deepseek-v4-flash")
  })
})

describe("submit_review tool spec", () => {
  test("validates the structured-findings contract", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "submit_review")
    expect(spec).toBeDefined()
    const parsed = spec!.inputSchema.safeParse({
      reviewer: "security",
      verdict: "fail",
      findings: [
        {
          id: "SEC-001",
          location: "api/login.ts:42",
          issue: "User input reaches query directly",
          suggested_fix: "Use parameterized query",
        },
      ],
    })
    expect(parsed.success).toBe(true)
    const data = parsed.data as { findings?: Array<{ id: string }> } | undefined
    expect(data?.findings?.[0]?.id).toBe("SEC-001")
  })

  test("rejects a bad verdict", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "submit_review")!
    expect(
      spec.inputSchema.safeParse({ reviewer: "x", verdict: "maybe" }).success,
    ).toBe(false)
  })
})

describe("checkpoint compatibility matrix", () => {
  test("every phase lists at least one allowed status", () => {
    for (const phase of checkpointPhases) {
      expect(checkpointPhaseStatus[phase].length).toBeGreaterThan(0)
    }
  })

  test("actionable error names the requirement, the received value, and the full matrix", () => {
    const error = checkpointMatrixError("blocked", "working")
    expect(error).toBe(
      [
        "Invalid checkpoint combination:",
        'phase="blocked" requires status="blocked"',
        'received status="working"',
        "",
        "Allowed:",
        "claimed → working",
        "started → working",
        "working → working",
        "milestone → working",
        "error → blocked",
        "blocked → blocked",
        "ready-for-review → complete",
      ].join("\n"),
    )
  })

  test("checkpoint spec accepts valid combos and rejects invalid ones", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "checkpoint")!
    expect(
      spec.inputSchema.safeParse({
        phase: "claimed",
        status: "working",
        message: "brief read",
      }).success,
    ).toBe(true)
    expect(
      spec.inputSchema.safeParse({
        phase: "ready-for-review",
        status: "complete",
        message: "done",
      }).success,
    ).toBe(true)
    const bad = spec.inputSchema.safeParse({
      phase: "claimed",
      status: "complete",
      message: "oops",
    })
    expect(bad.success).toBe(false)
    expect(String(bad.error?.issues[0]?.message)).toContain(
      'phase="claimed" requires status="working"',
    )
    expect(String(bad.error?.issues[0]?.message)).toContain("Allowed:")
  })

  test("heartbeat is gone from the tool surface", () => {
    expect((hamiltonToolNames as readonly string[]).includes("heartbeat")).toBe(
      false,
    )
    expect(
      hamiltonToolSpecs.some((s: { name: string }) => s.name === "heartbeat"),
    ).toBe(false)
  })

  test("start_run requires exactly one of planJson or prompt", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "start_run")!
    expect(spec.inputSchema.safeParse({ planJson: "{}" }).success).toBe(true)
    expect(spec.inputSchema.safeParse({ prompt: "build an app" }).success).toBe(
      true,
    )
    expect(spec.inputSchema.safeParse({}).success).toBe(false)
    expect(
      spec.inputSchema.safeParse({ planJson: "{}", prompt: "x" }).success,
    ).toBe(false)
  })

  test("run_status carries the read-only contract in its description", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "run_status")!
    expect(spec.description).toContain("MUST NOT")
    expect(spec.description).toContain("ONLY summarize")
  })
})

describe("hamiltonConfigSchema conductor additions", () => {
  test("parentBranch and protocol defaults", () => {
    const cfg = hamiltonConfigSchema.parse({})
    expect(cfg.parentBranch).toBe("main")
    expect(cfg.protocol).toEqual({ blockOnViolation: false })
  })

  test("accepts overrides", () => {
    const cfg = hamiltonConfigSchema.parse({
      parentBranch: "feat/webapp",
      protocol: { blockOnViolation: true },
    })
    expect(cfg.parentBranch).toBe("feat/webapp")
    expect(cfg.protocol.blockOnViolation).toBe(true)
  })
})
