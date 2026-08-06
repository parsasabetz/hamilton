import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfigFile } from "./config.ts"

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "hamilton-config-"))
}

describe("loadConfigFile", () => {
  test("defaults when no config file exists", async () => {
    const dir = tempDir()
    try {
      const loaded = await loadConfigFile(dir)
      expect(loaded.source).toBe("defaults")
      expect(loaded.config.watchCommands).toEqual(["git"])
      expect(loaded.config.earlyStop.maxFailedAgents).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads and validates a config file, merging defaults", async () => {
    const dir = tempDir()
    try {
      writeFileSync(
        join(dir, "hamilton.config.ts"),
        `export default { watchCommands: ["git", "npm"], leaseTtlMs: 5000 }`,
      )
      const loaded = await loadConfigFile(dir)
      expect(loaded.source).toBe("file")
      expect(loaded.config.watchCommands).toEqual(["git", "npm"])
      expect(loaded.config.leaseTtlMs).toBe(5000)
      expect(loaded.config.earlyStop.maxFailedAgents).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails loudly on a malformed config file", async () => {
    const dir = tempDir()
    try {
      writeFileSync(
        join(dir, "hamilton.config.ts"),
        `export default { leaseTtlMs: -5 }`,
      )
      await expect(loadConfigFile(dir)).rejects.toThrow(
        /invalid hamilton.config.ts/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
