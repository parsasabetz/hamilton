// Hamilton CLI (citty) — the primary entry point (HAMILTON.md §3, Core plane).

import { defineCommand, runMain } from "citty"
import { startCore } from "@hamilton/core"

const main = defineCommand({
  meta: {
    name: "hamilton",
    version: "0.0.0",
    description: "Multi-agent autonomous orchestration framework",
  },
  subCommands: {
    dev: defineCommand({
      meta: {
        name: "dev",
        description: "Start the Hamilton core: executor, API, and status page",
      },
      args: {
        port: {
          type: "string",
          description: "Port to listen on",
          default: "8787",
        },
      },
      async run({ args }) {
        const handle = startCore({ port: Number(args.port ?? "8787") })
        const shutdown = (): void => handle.stop()
        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)
      },
    }),
  },
})

runMain(main)
