import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { RunSnapshotView } from "./run.ts"
import { buildReport, finalExitCode, graphFilePath } from "./run.ts"

function snapshot(
  tasks: RunSnapshotView["tasks"],
  phase = "running",
): RunSnapshotView {
  return { runId: "run-1", phase, seq: 12, tasks }
}

describe("buildReport", () => {
  test("renders statuses, roles, branches, and the summary line", () => {
    const report = buildReport(
      snapshot([
        { id: "t1", status: "merged", role: "implementer", branch: "feat/t1" },
        { id: "t2", status: "in-progress", role: "implementer" },
        { id: "t3", status: "planned", role: "reviewer" },
      ]),
    )
    expect(report).toContain("run run-1 — phase running (seq 12)")
    expect(report).toContain("t1 [merged] (implementer) feat/t1")
    expect(report).toContain("t2 [in-progress] (implementer)")
    expect(report).toContain("t3 [planned] (reviewer)")
    expect(report).toContain("1 merged, 1 in-progress, 1 blocked/planned")
  })

  test("sorts tasks by id regardless of input order", () => {
    const report = buildReport(
      snapshot([
        { id: "t2", status: "merged", role: "implementer" },
        { id: "t1", status: "merged", role: "docs" },
      ]),
    )
    expect(report.indexOf("t1 [merged]")).toBeLessThan(
      report.indexOf("t2 [merged]"),
    )
  })

  test("counts reviewing and blocked tasks in the right buckets", () => {
    const report = buildReport(
      snapshot([
        { id: "t1", status: "merged", role: "implementer" },
        { id: "t2", status: "reviewing", role: "reviewer" },
        { id: "t3", status: "blocked", role: "implementer" },
      ]),
    )
    expect(report).toContain("1 merged, 1 in-progress, 1 blocked/planned")
  })

  test("omits empty roles and missing branches", () => {
    const report = buildReport(
      snapshot([{ id: "t1", status: "planned", role: "" }]),
    )
    expect(report).toContain("t1 [planned]")
    expect(report).not.toContain("()")
  })
})

describe("finalExitCode", () => {
  test("finished phase exits 0", () => {
    expect(
      finalExitCode(
        snapshot([{ id: "t1", status: "merged", role: "x" }], "finished"),
      ),
    ).toBe(0)
  })

  test("stopping phase exits 1", () => {
    expect(
      finalExitCode(
        snapshot([{ id: "t1", status: "in-progress", role: "x" }], "stopping"),
      ),
    ).toBe(1)
  })

  test("all tasks merged exits 0 even while running", () => {
    expect(
      finalExitCode(
        snapshot([
          { id: "t1", status: "merged", role: "x" },
          { id: "t2", status: "merged", role: "y" },
        ]),
      ),
    ).toBe(0)
  })

  test("blocked or pending tasks exit 1", () => {
    expect(
      finalExitCode(
        snapshot([
          { id: "t1", status: "merged", role: "x" },
          { id: "t2", status: "blocked", role: "y" },
        ]),
      ),
    ).toBe(1)
    expect(
      finalExitCode(snapshot([{ id: "t1", status: "planned", role: "x" }])),
    ).toBe(1)
  })

  test("empty task list exits 1 (nothing proven merged)", () => {
    expect(finalExitCode(snapshot([]))).toBe(1)
  })
})

describe("graphFilePath", () => {
  test("joins repo root with .hamilton/graph.yaml", () => {
    expect(graphFilePath("/tmp/project")).toBe(
      join("/tmp/project", ".hamilton", "graph.yaml"),
    )
  })
})
