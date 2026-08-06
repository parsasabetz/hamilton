// Hamilton MCP server (HAMILTON.md §7) — stdio, built on @modelcontextprotocol/sdk.
// Tool registry from @hamilton/shared; handlers emit onto the event bus in M1 —
// for now they log and acknowledge.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"
import { hamiltonToolSpecs } from "@hamilton/shared"

const VERSION = "0.0.0"

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

const logger = getLogger(["hamilton", "mcp"])

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "hamilton", version: VERSION })
  for (const spec of hamiltonToolSpecs) {
    server.registerTool(
      spec.name,
      {
        title: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      },
      async (_args) => {
        logger.info("Tool called: {name}", { name: spec.name })
        return {
          content: [
            {
              type: "text" as const,
              text: `[hamilton:${spec.name}] acknowledged — event spine lands in M1`,
            },
          ],
        }
      },
    )
  }
  return server
}

export async function runStdioServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

if (import.meta.main) {
  await runStdioServer()
}
