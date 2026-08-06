// Hamilton runtime config (HAMILTON.md — constants layer).
// Zod-validated against the shared schema; defaults apply; the Core passes
// the resolved config to the brain worker as a JSON binding (CONFIG).
//
// Resolution order (later wins): defaults < hamilton.config.ts < overrides.

import { existsSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"

import { hamiltonConfigSchema } from "@hamilton/shared"
import type { HamiltonConfig } from "@hamilton/shared"

export function resolveConfig(
  overrides: Partial<HamiltonConfig> = {},
): HamiltonConfig {
  return hamiltonConfigSchema.parse(overrides)
}

const CONFIG_FILENAME = "hamilton.config.ts"

export interface LoadedConfig {
  config: HamiltonConfig
  source: "defaults" | "file"
  file?: string
}

/**
 * Load ./hamilton.config.ts from cwd if present (default export: a partial
 * config object — no hamilton imports required, the zod schema validates it).
 * Fails loudly on a malformed file (the constants layer is trusted input).
 */
export async function loadConfigFile(cwd: string): Promise<LoadedConfig> {
  const file = join(cwd, CONFIG_FILENAME)
  if (!existsSync(file)) {
    return { config: resolveConfig(), source: "defaults" }
  }
  const imported = (await import(
    pathToFileURL(isAbsolute(file) ? file : join(cwd, file)).href
  )) as {
    default?: unknown
  }
  const parsed = hamiltonConfigSchema.safeParse(imported.default)
  if (!parsed.success) {
    throw new Error(
      `invalid ${CONFIG_FILENAME}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
        .join("; ")}`,
    )
  }
  return { config: parsed.data, source: "file", file }
}

export { hamiltonConfigSchema }
export type { HamiltonConfig }
