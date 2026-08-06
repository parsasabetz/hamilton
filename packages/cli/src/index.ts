// Hamilton CLI (citty) — the primary entry point (HAMILTON.md §3, Core plane).

import { defineCommand, runMain } from "citty"
import { startCore } from "@hamilton/core"
import { startConductor } from "./conductor.ts"
import { initProject } from "./init.ts"

const main = defineCommand({
  meta: {
    name: "hamilton",
    version: "0.0.0",
    description: "Multi-agent autonomous orchestration framework",
  },
  subCommands: {
    init: defineCommand({
      meta: {
        name: "init",
        description:
          "Create .hamilton/ (conductor + agent instructions) and hamilton.config.ts",
      },
      async run() {
        const result = initProject(process.cwd())
        for (const path of result.created) {
          console.log(`created  ${path}`)
        }
        for (const path of result.skipped) {
          console.log(`skipped  ${path} (already exists)`)
        }
        console.log("")
        console.log(
          "Hamilton initialized. Edit hamilton.config.ts to tune the run policy.",
        )
      },
    }),
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
        const handle = await startCore({ port: Number(args.port ?? "8787") })
        const shutdown = (): void => {
          void handle.stop()
        }
        process.on("SIGINT", shutdown)
        process.on("SIGTERM", shutdown)
      },
    }),
    start: defineCommand({
      meta: {
        name: "start",
        description: "Open a Conductor session (plan mode) for {project}",
      },
      args: {
        project: {
          type: "string",
          description: "Project name (default: current directory name)",
        },
      },
      async run({ args }) {
        try {
          const result = await startConductor(
            args.project ? { projectName: args.project } : {},
          )
          console.log(`Conductor session started`)
          console.log(`  title:    ${result.title}`)
          console.log(`  session:  ${result.sessionId}`)
          console.log(`  opencode: ${result.baseUrl}`)
          console.log("")
          console.log(`Attach with: opencode --session ${result.sessionId}`)
          console.log(`        or:  opencode attach ${result.baseUrl}`)
          console.log(
            "Confirming a plan hands execution to `hamilton run` (arrives with the dispatch milestone)",
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`hamilton start failed: ${message}`)
          process.exitCode = 1
        }
      },
    }),
  },
})

runMain(main)
