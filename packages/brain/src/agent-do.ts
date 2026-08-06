// Hamilton Brain — AgentDO: per-agent liveness DO with a heartbeat-expiry alarm
// (HAMILTON.md §5). The alarm is armed on register/heartbeat (now + 5 min) and, on
// expiry, marks the agent dead in storage and writes the REGISTRY snapshot. It does
// NOT re-arm itself.

import { DurableObject } from "cloudflare:workers"

import type { Env } from "./index.ts"
import { readJsonBody } from "./run-do.ts"

const HEARTBEAT_MS = 5 * 60_000

const KEYS = {
  runId: "runId",
  agentId: "agentId",
  taskId: "taskId",
  heartbeatAt: "heartbeatAt",
  lastActivityAt: "lastActivityAt",
  busy: "busy",
  stalledAt: "stalledAt",
  diedAt: "diedAt",
  registered: "registered",
} as const

export class AgentDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/state") {
      return this.state()
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 })
    }
    switch (url.pathname) {
      case "/register":
        return this.register(request)
      case "/heartbeat":
        return this.heartbeat()
      case "/activity":
        return this.activity()
      case "/stalled":
        return this.stalled()
      case "/idle":
        return this.idle()
      case "/died":
        return this.died()
      default:
        return new Response("not found", { status: 404 })
    }
  }

  override async alarm(): Promise<void> {
    const { runId, agentId } = await this.identities()
    if (agentId === "") return
    const heartbeatAt = await this.ctx.storage.get<string>(KEYS.heartbeatAt)
    const ageMs =
      heartbeatAt === undefined
        ? HEARTBEAT_MS + 1
        : Date.now() - Date.parse(heartbeatAt)
    if (!Number.isFinite(ageMs) || ageMs <= HEARTBEAT_MS) return
    await this.ctx.storage.put(KEYS.diedAt, new Date().toISOString())
    await this.writeSnapshot(runId, agentId)
  }

  private async register(request: Request): Promise<Response> {
    const body = await readJsonBody(request)
    const taskId = body?.taskId
    if (typeof taskId !== "string") {
      return new Response("taskId required", { status: 400 })
    }
    const { runId, agentId } = await this.identities()
    await this.ctx.storage.put({
      [KEYS.runId]: runId,
      [KEYS.agentId]: agentId,
      [KEYS.taskId]: taskId,
      [KEYS.registered]: true,
    })
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
    return Response.json({ ok: true })
  }

  private async heartbeat(): Promise<Response> {
    await this.ctx.storage.put(KEYS.heartbeatAt, new Date().toISOString())
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS)
    return Response.json({ ok: true })
  }

  private async activity(): Promise<Response> {
    await this.ctx.storage.put(KEYS.lastActivityAt, new Date().toISOString())
    return Response.json({ ok: true })
  }

  private async stalled(): Promise<Response> {
    await this.ctx.storage.put(KEYS.stalledAt, new Date().toISOString())
    return Response.json({ ok: true })
  }

  private async idle(): Promise<Response> {
    await this.ctx.storage.put(KEYS.busy, false)
    return Response.json({ ok: true })
  }

  private async died(): Promise<Response> {
    await this.ctx.storage.put(KEYS.diedAt, new Date().toISOString())
    await this.ctx.storage.deleteAlarm()
    return Response.json({ ok: true })
  }

  private async state(): Promise<Response> {
    const { runId, agentId } = await this.identities()
    const [
      taskId,
      heartbeatAt,
      lastActivityAt,
      busy,
      stalledAt,
      diedAt,
      registered,
    ] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.taskId),
      this.ctx.storage.get<string>(KEYS.heartbeatAt),
      this.ctx.storage.get<string>(KEYS.lastActivityAt),
      this.ctx.storage.get<boolean>(KEYS.busy),
      this.ctx.storage.get<string>(KEYS.stalledAt),
      this.ctx.storage.get<string>(KEYS.diedAt),
      this.ctx.storage.get<boolean>(KEYS.registered),
    ])
    return Response.json({
      runId,
      agentId,
      taskId,
      registered: registered ?? false,
      heartbeatAt,
      lastActivityAt,
      busy: busy ?? false,
      stalledAt,
      diedAt,
      heartbeatAgeMs:
        heartbeatAt === undefined
          ? 0
          : Math.max(0, Date.now() - Date.parse(heartbeatAt)),
    })
  }

  private async writeSnapshot(runId: string, agentId: string): Promise<void> {
    const [taskId, heartbeatAt, lastActivityAt, busy, stalledAt, diedAt] =
      await Promise.all([
        this.ctx.storage.get<string>(KEYS.taskId),
        this.ctx.storage.get<string>(KEYS.heartbeatAt),
        this.ctx.storage.get<string>(KEYS.lastActivityAt),
        this.ctx.storage.get<boolean>(KEYS.busy),
        this.ctx.storage.get<string>(KEYS.stalledAt),
        this.ctx.storage.get<string>(KEYS.diedAt),
      ])
    await this.env.REGISTRY.put(
      `state:${runId}:agent:${agentId}`,
      JSON.stringify({
        agentId,
        runId,
        taskId,
        state:
          diedAt !== undefined
            ? "died"
            : heartbeatAt !== undefined
              ? "alive"
              : "unknown",
        heartbeatAt,
        lastActivityAt,
        busy,
        stalledAt,
        diedAt,
      }),
    )
  }

  private async identities(): Promise<{ runId: string; agentId: string }> {
    const [storedRunId, storedAgentId] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.runId),
      this.ctx.storage.get<string>(KEYS.agentId),
    ])
    if (storedRunId !== undefined && storedAgentId !== undefined) {
      return { runId: storedRunId, agentId: storedAgentId }
    }
    const name = this.ctx.id.name
    if (name !== undefined) {
      const parts = name.split(":")
      if (parts.length >= 3) {
        return { runId: parts[1] ?? "", agentId: parts.slice(2).join(":") }
      }
    }
    return { runId: "", agentId: "" }
  }
}
