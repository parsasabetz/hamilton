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
      expect(result.created).toContain("hamilton.config.ts")

      const conductor = readFileSync(
        join(dir, ".hamilton/CONDUCTOR.md"),
        "utf8",
      )
      expect(conductor).toContain("Conductor")
      expect(conductor).toContain("never edit code")

      const agents = readFileSync(join(dir, ".hamilton/AGENTS.md"), "utf8")
      expect(agents).toContain("heartbeat")
      expect(agents).toContain("ready_for_review")
      expect(agents).toContain("never `git add -A`")

      const config = readFileSync(join(dir, "hamilton.config.ts"), "utf8")
      expect(config).toContain("export default")
      expect(config).toContain("watchCommands")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("skips existing files without overwriting", () => {
    const dir = tempDir()
    try {
      const first = initProject(dir)
      expect(first.created).toHaveLength(3)

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
