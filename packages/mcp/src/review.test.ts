import { describe, expect, test } from "bun:test"
import { hamiltonToolSpecs } from "@hamilton/shared"
import { submitReviewPayload, type SubmitReviewArgs } from "./index.ts"

const fullArgs: SubmitReviewArgs = {
  reviewer: "security",
  verdict: "fail",
  findings: [
    {
      id: "SEC-001",
      location: "api/login.ts:42",
      issue: "missing rate limit",
      suggested_fix: "add a rate limiter",
    },
  ],
  checksRun: [
    { name: "typecheck", ok: true },
    { name: "tests", ok: false },
  ],
  testsWritten: ["api/login.test.ts"],
  summary: "auth surface needs hardening",
}

describe("submitReviewPayload", () => {
  test("includes all fields for a full submission", () => {
    const payload = submitReviewPayload(fullArgs)
    expect(payload).toEqual(fullArgs as unknown as Record<string, unknown>)
  })

  test("omits undefined optional fields", () => {
    const payload = submitReviewPayload({
      reviewer: "security",
      verdict: "pass",
    })
    expect(payload).toEqual({
      reviewer: "security",
      verdict: "pass",
      findings: [],
    })
    expect("checksRun" in payload).toBe(false)
    expect("testsWritten" in payload).toBe(false)
    expect("summary" in payload).toBe(false)
  })

  test("passes findings through untouched", () => {
    const findings = [
      { id: "F-1", location: "src/a.ts:1", issue: "x" },
      { id: "F-2", location: "src/b.ts:2", issue: "y", suggested_fix: "z" },
    ]
    const payload = submitReviewPayload({
      reviewer: "r",
      verdict: "fail",
      findings,
    })
    expect(payload["findings"]).toEqual(findings)
  })

  test("defaults findings to an empty array when absent", () => {
    const payload = submitReviewPayload({
      reviewer: "r",
      verdict: "pass",
      testsWritten: ["a.test.ts"],
    })
    expect(payload["findings"]).toEqual([])
    expect(payload["testsWritten"]).toEqual(["a.test.ts"])
  })
})

describe("submit_review tool spec", () => {
  test("is registered in hamiltonToolSpecs", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "submit_review")
    expect(spec).toBeDefined()
    expect(spec?.description).toContain("structured review")
  })

  test("spec validates a verdict enum and a findings shape", () => {
    const spec = hamiltonToolSpecs.find((s) => s.name === "submit_review")
    expect(spec).toBeDefined()
    if (spec === undefined) return
    const ok = spec.inputSchema.safeParse({
      reviewer: "security",
      verdict: "fail",
      findings: [{ id: "SEC-001", location: "a.ts:1", issue: "x" }],
    })
    expect(ok.success).toBe(true)
    const bad = spec.inputSchema.safeParse({ reviewer: "r", verdict: "maybe" })
    expect(bad.success).toBe(false)
  })
})
