import { describe, expect, test } from "bun:test"
import { taskSchema } from "./index.ts"

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
