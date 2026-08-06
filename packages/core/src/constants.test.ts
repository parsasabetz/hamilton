import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  parseFrontmatter,
  readReviewerInstructions,
  validateConfig,
  validateHamiltonDir,
} from "./constants.ts"

const VALID_REVIEWER = `---
description: Read-only gate reviewer
mode: primary
permission:
  edit: deny
  bash:
    "*": deny
---

You judge work; you never change it.
`

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hamilton-constants-"))
}

describe("parseFrontmatter", () => {
  test("parses a valid frontmatter block", () => {
    const parsed = parseFrontmatter(VALID_REVIEWER)
    expect(parsed).not.toBeNull()
    expect(parsed?.metaLines.some((l) => l.includes("edit: deny"))).toBe(true)
    expect(parsed?.body).toContain("never change it")
  })

  test("rejects content without frontmatter", () => {
    expect(parseFrontmatter("# plain markdown")).toBeNull()
    expect(parseFrontmatter("---\nunclosed")).toBeNull()
  })
})

describe("validateHamiltonDir", () => {
  test("missing directory is a loud issue", () => {
    const dir = tempDir()
    const result = validateHamiltonDir(join(dir, "nope"))
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toContain("hamilton init")
    rmSync(dir, { recursive: true, force: true })
  })

  test("valid reviewer file passes", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "reviewer-agent.md"), VALID_REVIEWER)
      writeFileSync(join(dir, "CONDUCTOR.md"), "# conductor\n")
      const result = validateHamiltonDir(dir)
      expect(result.ok).toBe(true)
      expect(result.issues).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("flags a reviewer file that can edit", () => {
    const dir = tempDir()
    try {
      writeFileSync(
        join(dir, "reviewer-agent.md"),
        "---\ndescription: x\nmode: primary\npermission:\n  edit: allow\n---\nbody",
      )
      const result = validateHamiltonDir(dir)
      expect(result.ok).toBe(false)
      expect(result.issues.some((i) => i.includes("deny"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("flags empty markdown files", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "AGENTS.md"), "   \n")
      const result = validateHamiltonDir(dir)
      expect(result.ok).toBe(false)
      expect(result.issues.some((i) => i.includes("empty"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("readReviewerInstructions", () => {
  test("returns the body without the frontmatter", () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, "reviewer-agent.md"), VALID_REVIEWER)
      expect(readReviewerInstructions(dir)).toBe(
        "You judge work; you never change it.\n",
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("validateConfig", () => {
  test("valid partial config passes with defaults filled", () => {
    const result = validateConfig({ watchCommands: ["git", "npm"] })
    expect(result.ok).toBe(true)
    expect(result.config?.watchCommands).toEqual(["git", "npm"])
    expect(result.config?.review.roles).toEqual(["correctness", "standards"])
  })

  test("invalid values produce path-annotated issues", () => {
    const result = validateConfig({ leaseTtlMs: -1 })
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toContain("leaseTtlMs")
  })
})
