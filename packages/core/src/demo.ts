// M1 demo — the event spine end-to-end, driven through the real MCP server:
//
//   agent (JSON-RPC over stdio) → MCP tools → POST /api/events → bus (KV log +
//   queue) → RunDO (workerd) → KV snapshot → /api/state → page data
//
// Also proves basic resumption: the core is stopped and restarted on the same
// persist dir, and the run state survives.
//
// Run: bun packages/core/src/demo.ts

import { startCore } from "./index.ts"

const PORT = 8791
const RUN_ID = "demo-run"
const PERSIST_DIR = ".mf-demo"
const MCP_ENTRY = new URL("../../mcp/src/index.ts", import.meta.url).pathname

let failures = 0

function check(name: string, ok: boolean, detail = ""): void {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  )
  if (!ok) failures += 1
}

interface JsonRpcMessage {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

class McpClient {
  private process: Bun.Subprocess
  private buffer = ""
  private pending = new Map<number, (msg: JsonRpcMessage) => void>()
  private nextId = 1

  constructor() {
    this.process = Bun.spawn({
      cmd: ["bun", MCP_ENTRY],
      env: {
        ...Bun.env,
        HAMILTON_CORE_URL: `http://localhost:${PORT}`,
        HAMILTON_RUN_ID: RUN_ID,
        HAMILTON_TASK_ID: "t1",
        HAMILTON_AGENT_ID: "a1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    })
    const stdout = this.process.stdout
    if (!(stdout instanceof ReadableStream))
      throw new Error("mcp stdout not piped")
    const reader = stdout.getReader()
    const pump = (): void => {
      void reader.read().then(({ value, done }) => {
        if (done) return
        this.buffer += new TextDecoder().decode(value)
        let index: number
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 1)
          if (line.trim() === "") continue
          try {
            const msg = JSON.parse(line) as JsonRpcMessage
            if (typeof msg.id === "number") {
              const resolve = this.pending.get(msg.id)
              if (resolve) {
                this.pending.delete(msg.id)
                resolve(msg)
              }
            }
          } catch {
            // ignore non-JSON output on stdout
          }
        }
        pump()
      })
    }
    pump()
  }

  async call(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++
    const message: JsonRpcMessage = { jsonrpc: "2.0", id, method, params }
    const stdin = this.process.stdin
    if (typeof stdin !== "object" || stdin === null) {
      throw new Error("mcp stdin not piped")
    }
    stdin.write(JSON.stringify(message) + "\n")
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp timeout for ${method}`))
      }, 10_000)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  kill(): void {
    this.process.kill()
  }
}

async function callTool(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
  settleMs = 250,
): Promise<JsonRpcMessage> {
  const result = await client.call("tools/call", { name, arguments: args })
  await Bun.sleep(settleMs)
  return result
}

async function fetchState(): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `http://localhost:${PORT}/api/state?run=${RUN_ID}`,
  )
  if (!response.ok) return null
  const data = (await response.json()) as Record<string, unknown>
  return data["snapshot"] as Record<string, unknown> | null
}

async function waitForTaskStatus(
  status: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- deliberate poll loop
    const snapshot = await fetchState()
    const tasks = snapshot?.["tasks"]
    if (Array.isArray(tasks)) {
      const task = tasks.find(
        (t): t is Record<string, unknown> =>
          typeof t === "object" && t !== null && t["id"] === "t1",
      )
      if (task && task["status"] === status) return snapshot
    }
    // oxlint-disable-next-line no-await-in-loop -- deliberate poll loop
    await Bun.sleep(200)
  }
  return null
}

console.log(`M1 demo — event spine end-to-end (port ${PORT}, run ${RUN_ID})`)
console.log("step 1: clean persist dir")
Bun.spawnSync(["rm", "-rf", PERSIST_DIR])

console.log("step 2: boot core")
let handle = await startCore({
  port: PORT,
  persistDir: PERSIST_DIR,
  runId: RUN_ID,
})

console.log("step 3: drive the agent through the MCP server")
const client = new McpClient()
const init = await client.call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "demo", version: "0.0.0" },
})
check("mcp initialize", init.result !== undefined)
await client.call("notifications/initialized")

const claimed = await callTool(client, "checkpoint", {
  phase: "claimed",
  status: "working",
  message: "brief read; plan recorded",
})
check("checkpoint(claimed) emits", claimed.result !== undefined)
const claimedEmitted =
  isRecord(claimed.result) && claimed.result["content"] !== undefined
check("checkpoint response", claimedEmitted)

// The heartbeat tool was removed — aliveness is derived from checkpoints,
// tool activity, and git. A bad phase/status combo must error with the
// actionable matrix message.
const bad = await callTool(client, "checkpoint", {
  phase: "blocked",
  status: "working",
  message: "oops",
})
const badError = isRecord(bad.result) && bad.result["isError"] === true
const badContent = isRecord(bad.result) ? bad.result["content"] : undefined
const badText = Array.isArray(badContent)
  ? String((badContent[0] as { text?: unknown } | undefined)?.["text"] ?? "")
  : ""
check(
  "matrix violation errors with the actionable message",
  badError && badText.includes('phase="blocked" requires status="blocked"'),
)
check("matrix error lists Allowed", badText.includes("Allowed:"))

await callTool(client, "checkpoint", {
  phase: "started",
  status: "working",
  message: "first edit done",
})
await callTool(client, "checkpoint", {
  phase: "milestone",
  status: "working",
  message: "feature implemented; tests green",
  files: ["src/feature.ts"],
})
const ready = await callTool(client, "ready_for_review", {
  summary: "t1 done",
  branch: "feat/t1",
  checks: { typecheck: true },
})
check("ready_for_review emits", isRecord(ready.result))

console.log("step 4: verify state via /api/state")
const snapshot = await waitForTaskStatus("ready-for-review")
check("task t1 reaches ready-for-review", snapshot !== null)
const agents = snapshot?.["agents"]
const agent = Array.isArray(agents)
  ? agents.find(
      (a): a is Record<string, unknown> =>
        typeof a === "object" && a !== null && a["agentId"] === "a1",
    )
  : undefined
check("agent a1 registered", agent !== undefined)
check("agent a1 ready-for-review", agent?.["state"] === "ready-for-review")
const phase = snapshot?.["phase"]
check("run phase recorded", typeof phase === "string")
const seq = snapshot?.["seq"]
check("seq advanced", typeof seq === "number" && seq >= 4)

const tailResponse = await fetch(
  `http://localhost:${PORT}/api/events?run=${RUN_ID}&n=50`,
)
const tail = (await tailResponse.json()) as unknown[]
check("event tail served", Array.isArray(tail) && tail.length >= 4)

console.log("step 5: resumption — stop core, restart on same persist dir")
client.kill()
await handle.stop()
handle = await startCore({ port: PORT, persistDir: PERSIST_DIR, runId: RUN_ID })
const resumed = await waitForTaskStatus("ready-for-review", 5000)
check("run state survives restart", resumed !== null)

console.log("step 6: cleanup")
await handle.stop()
Bun.spawnSync(["rm", "-rf", PERSIST_DIR])

if (failures > 0) {
  console.log(`\nM1 demo: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log(
  "\nM1 demo: all checks passed — agent → MCP → bus → RunDO → state → page",
)
process.exit(0)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
