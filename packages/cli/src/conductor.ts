// Conductor session bootstrap — opens a plan-mode OpenCode session
// the user talks to (HAMILTON.md §8, Conductor plane).

import { basename } from "node:path"
import { createControlPlane, validateHamiltonDir } from "@hamilton/core"

const DEFAULT_OPCODE_URL = "http://localhost:4096"
const SERVER_PORT = "4096"
const HEALTH_POLL_MS = 500
const HEALTH_TIMEOUT_MS = 30_000

export function conductorTitle(projectName: string): string {
  return `Conductor | ${projectName}`
}

export function conductorPrompt(projectName: string): string {
  return [
    conductorTitle(projectName),
    "",
    `You are the Conductor of the Hamilton orchestration framework for the project ${projectName}.`,
    "You are in plan mode: you read and produce plans; you never write code directly.",
    "Read the repo's HAMILTON.md, FEATURES.md, and ROADMAP.md (the design contract) plus AGENTS.md.",
    "When the user asks for work: decompose into a plan; confirm with the user before executing.",
    "Upon user confirmation, execution is handed to the autonomous Hamilton loop (hamilton run) which dispatches implementer agents; you supervise outcomes, reviews, and merges.",
    "Report back to the user when the work is done, or immediately on critical failure.",
  ].join("\n")
}

export interface ConductorStartResult {
  sessionId: string
  title: string
  baseUrl: string
}

async function isHealthy(
  cp: ReturnType<typeof createControlPlane>,
): Promise<boolean> {
  try {
    return (await cp.health()) !== null
  } catch {
    return false
  }
}

function spawnOpencodeServer(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn({
    cmd: [
      "opencode",
      "serve",
      "--port",
      SERVER_PORT,
      "--hostname",
      "127.0.0.1",
    ],
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
  })
}

async function waitForHealthy(
  cp: ReturnType<typeof createControlPlane>,
  deadline: number,
): Promise<boolean> {
  if (Date.now() >= deadline) return false
  await Bun.sleep(HEALTH_POLL_MS)
  if (await isHealthy(cp)) return true
  return waitForHealthy(cp, deadline)
}

export async function startConductor(
  options: {
    baseUrl?: string
    projectName?: string
  } = {},
): Promise<ConductorStartResult> {
  const projectName = options.projectName ?? basename(process.cwd())
  const baseUrl =
    options.baseUrl ?? process.env.HAMILTON_OPCODE_URL ?? DEFAULT_OPCODE_URL

  // The constants layer must be valid before the conductor can trust it
  // (HAMILTON.md §6) — malformed .hamilton files fail the start.
  const validation = validateHamiltonDir(process.cwd())
  if (!validation.ok) {
    throw new Error(
      "invalid .hamilton constants:\n" +
        validation.issues.map((issue) => `  - ${issue}`).join("\n"),
    )
  }

  const cp = createControlPlane({ baseUrl })

  let child: ReturnType<typeof Bun.spawn> | undefined
  if (!(await isHealthy(cp))) {
    child = spawnOpencodeServer()
    process.on("exit", () => child?.kill())
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    if (!(await waitForHealthy(cp, deadline))) {
      throw new Error(
        `opencode server did not come up at ${baseUrl} within 30s. ` +
          "Start it manually with `opencode serve --port 4096` or set HAMILTON_OPCODE_URL to a running instance.",
      )
    }
  }

  const created = await cp.client.v2.session.create({ agent: "plan" })
  const sessionId = created.data?.data?.id
  if (!sessionId) {
    throw new Error("opencode did not return a session id")
  }

  await cp.client.v2.session.prompt({
    sessionID: sessionId,
    prompt: { text: conductorPrompt(projectName) },
  })

  return { sessionId, title: conductorTitle(projectName), baseUrl }
}
