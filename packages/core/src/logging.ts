// Hamilton LogTape configuration — configured exactly ONCE per process.
//
// Both @hamilton/core and @hamilton/mcp configure the same loggers
// (["hamilton", ...]); LogTape's global config throws on a second
// configureSync, and tests load both packages in one process. The guard uses
// a global Symbol so every module shares the flag.

import { configureSync, getConsoleSink } from "@logtape/logtape"

const LOGGING_KEY = Symbol.for("hamilton.logging.configured")

export function configureHamiltonLogging(): void {
  const global = globalThis as Record<PropertyKey, unknown>
  if (global[LOGGING_KEY] === true) return
  global[LOGGING_KEY] = true
  configureSync({
    sinks: { console: getConsoleSink() },
    filters: { "*": "info" },
    loggers: [
      { category: ["hamilton"], lowestLevel: "info", sinks: ["console"] },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["console"],
      },
    ],
  })
}
