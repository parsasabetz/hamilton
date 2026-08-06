import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_INIT_FILES, initProject } from "./init.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hamilton-init-"))
}

describe("initProject", () => {
  test("writes all files with key content", () => {
    const dir = tempDir()
    try {
      const result = initProject(dir)
      expect(result.created.toSorted()).toEqual(
        Object.keys(DEFAULT_INIT_FILES).toSorted(),
      )
      expect(result.skipped).toEqual([])
      expect(result.created).toContain(".hamilton/CONDUCTOR.md")
      expect(result.created).toContain(".hamilton/AGENTS.md")
      expect(result.created).toContain(".hamilton/REVIEWERS.md")
      expect(result.created).toContain("hamilton.config.ts")

      const conductor = readFileSync(
        join(dir, ".hamilton/CONDUCTOR.md"),
        "utf8",
      )
      expect(conductor).toContain("Conductor")
      expect(conductor).toContain("never edit code")

      const agents = readFileSync(join(dir, ".hamilton/AGENTS.md"), "utf8")
      expect(agents).toContain("ready_for_review")
      expect(agents).toContain("start_run")
      expect(agents).not.toContain("heartbeat")

      const reviewers = readFileSync(
        join(dir, ".hamilton/REVIEWERS.md"),
        "utf8",
      )
      expect(reviewers).toContain("submit_review")
      expect(reviewers).toContain("start_run")
      expect(reviewers).not.toContain("heartbeat")

      const config = readFileSync(join(dir, "hamilton.config.ts"), "utf8")
      expect(config).toContain("export default")
      expect(config).toContain("watchCommands")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("renders the tool table from the live specs", () => {
    const dir = tempDir()
    try {
      initProject(dir)
      for (const file of [
        ".hamilton/AGENTS.md",
        ".hamilton/CONDUCTOR.md",
        ".hamilton/REVIEWERS.md",
      ]) {
        const content = readFileSync(join(dir, file), "utf8")
        expect(content).toContain("| tool | params | what it does |")
        expect(content).toContain("| start_run |")
        expect(content).toContain("| run_status |")
        expect(content).not.toContain("| heartbeat |")
        expect(content).not.toContain("heartbeat")
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("AGENTS template carries the 6 safety rules", () => {
    const dir = tempDir()
    try {
      initProject(dir)
      const agents = readFileSync(join(dir, ".hamilton/AGENTS.md"), "utf8")
      expect(agents).toContain("The 6 safety rules")
      expect(agents).toMatch(/1\. No edits on other branches or worktrees/)
      expect(agents).toMatch(/6\. The conductor assigns your parent branch/)
      expect(agents).toContain("PR")
      expect(agents).toContain("parent")
      expect(agents).toContain("ready-for-review → complete")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("CONDUCTOR template mentions assistants and the trigger", () => {
    const dir = tempDir()
    try {
      initProject(dir)
      const conductor = readFileSync(
        join(dir, ".hamilton/CONDUCTOR.md"),
        "utf8",
      )
      expect(conductor).toContain("assistants")
      expect(conductor).toContain("start_run")
      expect(conductor).toContain("run_status")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips existing files without overwriting", () => {
    const dir = tempDir()
    try {
      const first = initProject(dir)
      expect(first.created).toHaveLength(4)

      const second = initProject(dir)
      expect(second.created).toEqual([])
      expect(second.skipped.toSorted()).toEqual(
        Object.keys(DEFAULT_INIT_FILES).toSorted(),
      )
      expect(readFileSync(join(dir, "hamilton.config.ts"), "utf8")).toContain(
        "export default",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
