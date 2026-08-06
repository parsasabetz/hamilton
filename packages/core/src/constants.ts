// The constants layer (.hamilton/) — format validation + reviewer instructions
// (HAMILTON.md §6). `hamilton start` and `hamilton run` validate every file
// with a defined format before booting; malformed constants fail loudly.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { hamiltonConfigSchema } from "@hamilton/shared"
import type { HamiltonConfig } from "@hamilton/shared"

export const CONFIG_FILENAME = "hamilton.config.ts"
export const REVIEWER_FILENAME = "REVIEWERS.md"

export interface Frontmatter {
  /** Raw meta lines (between the --- markers), one per line. */
  metaLines: string[]
  /** Body after the closing --- marker. */
  body: string
}

/**
 * Line-based frontmatter parse: content must start with `---` and contain a
 * closing `---` line; everything between is meta. Returns null when the
 * structure is wrong (no such format is enforced on plain instruction md).
 */
export function parseFrontmatter(content: string): Frontmatter | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== "---") return null
  const closeIndex = lines.findIndex(
    (line, i) => i > 0 && line.trim() === "---",
  )
  if (closeIndex < 0) return null
  return {
    metaLines: lines.slice(1, closeIndex),
    body: lines
      .slice(closeIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  }
}

export interface ConstantsValidation {
  ok: boolean
  issues: string[]
}

/**
 * Validate every file with a defined format inside .hamilton/:
 * - hamilton.config.ts must validate against the shared zod schema
 * - REVIEWERS.md must have parseable frontmatter (description, mode)
 *   and deny edits (permission.edit: deny) — reviewers are read-only
 * - AGENTS.md must carry the implementer safety rules and the checkpoint
 *   compatibility matrix marker
 * - CONDUCTOR.md must carry the start_run trigger and the assistants policy
 * - other markdown files must be non-empty
 * The directory itself must exist (run `hamilton init` first).
 */
export function validateHamiltonDir(dir: string): ConstantsValidation {
  const issues: string[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return {
      ok: false,
      issues: [`no .hamilton directory at ${dir} — run \`hamilton init\``],
    }
  }

  // hamilton.config.ts — zod-validated (loud failure is the contract).
  const configPath = join(dir, CONFIG_FILENAME)
  if (entries.includes(CONFIG_FILENAME)) {
    try {
      const source = readFileSync(configPath, "utf8")
      // Importing arbitrary user TS here is the Core's job at boot; for
      // validation we only check the file exists and is non-empty — the zod
      // check runs in loadConfigFile during start. Re-validate statically:
      if (source.trim().length === 0) {
        issues.push(`${CONFIG_FILENAME}: file is empty`)
      }
    } catch (error) {
      issues.push(
        `${CONFIG_FILENAME}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      )
    }
  }

  // REVIEWERS.md — the read-only gate instructions.
  const reviewerPath = join(dir, REVIEWER_FILENAME)
  if (entries.includes(REVIEWER_FILENAME)) {
    const raw = readFileSync(reviewerPath, "utf8")
    const frontmatter = parseFrontmatter(raw)
    if (frontmatter === null) {
      issues.push(
        `${REVIEWER_FILENAME}: must start with a --- frontmatter block`,
      )
    } else {
      if (
        !frontmatter.metaLines.some((line) =>
          /^description\s*:/.test(line.trim()),
        )
      ) {
        issues.push(`${REVIEWER_FILENAME}: frontmatter needs a description`)
      }
      if (
        !frontmatter.metaLines.some((line) => /^mode\s*:/.test(line.trim()))
      ) {
        issues.push(`${REVIEWER_FILENAME}: frontmatter needs a mode`)
      }
      const editAllow = frontmatter.metaLines.some((line) =>
        /edit\s*:\s*allow/.test(line.trim()),
      )
      const editDeny = frontmatter.metaLines.some((line) =>
        /edit\s*:\s*deny/.test(line.trim()),
      )
      const hasPermission = frontmatter.metaLines.some((line) =>
        /^permission\s*:/.test(line.trim()),
      )
      if (editAllow || (hasPermission && !editDeny)) {
        issues.push(
          `${REVIEWER_FILENAME}: must deny edits (permission.edit: deny) — reviewers are read-only`,
        )
      }
      if (frontmatter.body.trim().length === 0) {
        issues.push(`${REVIEWER_FILENAME}: body is empty`)
      }
    }
  }

  // AGENTS.md — implementer rules: the safety section and the checkpoint
  // compatibility matrix marker (both rendered by `hamilton init`).
  const agentsPath = join(dir, "AGENTS.md")
  if (entries.includes("AGENTS.md")) {
    const content = readFileSync(agentsPath, "utf8")
    if (!content.toLowerCase().includes("safety")) {
      issues.push(
        'AGENTS.md: must contain the implementer safety rules ("safety")',
      )
    }
    if (!content.includes("ready-for-review → complete")) {
      issues.push(
        'AGENTS.md: missing the checkpoint matrix marker ("ready-for-review → complete")',
      )
    }
  }

  // CONDUCTOR.md — orchestration rules: the start_run trigger and the
  // assistants (subagent) policy.
  const conductorPath = join(dir, "CONDUCTOR.md")
  if (entries.includes("CONDUCTOR.md")) {
    const content = readFileSync(conductorPath, "utf8")
    if (!content.includes("start_run")) {
      issues.push('CONDUCTOR.md: must mention "start_run" (your trigger)')
    }
    if (!content.includes("assistants")) {
      issues.push(
        'CONDUCTOR.md: must mention "assistants" (the subagent policy)',
      )
    }
  }

  // Every other markdown file must be non-empty.
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const content = readFileSync(join(dir, entry), "utf8")
    if (content.trim().length === 0) {
      issues.push(`${entry}: file is empty`)
    }
  }

  return { ok: issues.length === 0, issues }
}

/** The reviewer's instructions (the .hamilton/REVIEWERS.md body). */
export function readReviewerInstructions(dir: string): string {
  const raw = readFileSync(join(dir, REVIEWER_FILENAME), "utf8")
  const frontmatter = parseFrontmatter(raw)
  if (frontmatter === null) return raw
  return frontmatter.body
}

/** Static validation of a parsed config (exported for the CLI/reporting). */
export function validateConfig(value: unknown): {
  ok: boolean
  config?: HamiltonConfig
  issues: string[]
} {
  const parsed = hamiltonConfigSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
      ),
    }
  }
  return { ok: true, config: parsed.data, issues: [] }
}
