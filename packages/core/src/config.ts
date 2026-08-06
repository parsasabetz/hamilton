// Hamilton runtime config (HAMILTON.md — constants layer).
// Zod-validated against the shared schema; defaults apply; the Core passes
// the resolved config to the brain worker as a JSON binding (CONFIG).

import { hamiltonConfigSchema } from "@hamilton/shared"
import type { HamiltonConfig } from "@hamilton/shared"

export function resolveConfig(
  overrides: Partial<HamiltonConfig> = {},
): HamiltonConfig {
  return hamiltonConfigSchema.parse(overrides)
}

export { hamiltonConfigSchema }
export type { HamiltonConfig }
