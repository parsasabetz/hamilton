// Hamilton Brain — AgentDO: per-agent liveness DO with an activity-expiry alarm
// (HAMILTON.md §5). The alarm fires when NO activity — lastActivityAt or
// heartbeatAt, whichever is newer — has arrived within the expiry window.
// armExpiry schedules it; on expiry the agent is marked dead in storage (only
// when it stayed silent since arming) and the REGISTRY snapshot is written.
// The alarm does NOT re-arm itself. Hook-level: nothing calls armExpiry yet
// (M4 wires it); the register/heartbeat endpoints keep arming the legacy beat
// alarm for compatibility, and the alarm falls back to HEARTBEAT_MS when no
// armExpiry window has been stored.

import { DurableObject } from "cloudflare:workers"

import type { Env } from "./index.ts"
import { readJsonBody } from "./run-do.ts"

const HEARTBEAT_MS = 5 * 60_000

const KEYS = {
  runId: "runId",
  agentId: "agentId",
  taskId: "taskId",
  /** Last explicit bridge liveness beat (agent.heartbeat). */
  heartbeatAt: "heartbeatAt",
  /** Last activity signal — milestones, telemetry, commits (agent.milestone
   *  and the other activity pokes). The expiry alarm watches this alongside
   *  heartbeatAt, whichever is newer. */
  lastActivityAt: "lastActivityAt",
  busy: "busy",
  stalledAt: "stalledAt",
  /** Set once the activity-expiry alarm fires and no activity since arming. */
  diedAt: "diedAt",
  /** Expiry window armed by the last armExpiry call (fallback HEARTBEAT_MS). */
  expiryWindowMs: "expiryWindowMs",
  registered: "registered",
} as const

// Pure expiry math (unit-testable; armExpiry/alarm are the DO wiring).
//
// Arm time: with no signal yet, the alarm fires windowMs from now; otherwise
// windowMs after the last signal, never sooner than 1s out (a stale last
// signal must not arm an already-overdue alarm).
export function expiryArmTime(
  lastSignalMs: number,
  windowMs: number,
  nowMs: number,
): number {
  if (lastSignalMs <= 0) return nowMs + windowMs
  return Math.max(lastSignalMs + windowMs, nowMs + 1_000)
}

// Expired when the last signal is at least windowMs old (or never existed);
// garbage timestamps never kill an agent.
export function expiryExpired(
  lastSignalMs: number,
  nowMs: number,
  windowMs: number,
): boolean {
  const ageMs = lastSignalMs <= 0 ? windowMs + 1 : nowMs - lastSignalMs
  return Number.isFinite(ageMs) && ageMs >= windowMs
}

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
    await this.ctx.storage.deleteAlarm()
    const { runId, agentId } = await this.identities()
    if (agentId === "") return
    const [heartbeatAt, lastActivityAt, expiryWindowMs] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.heartbeatAt),
      this.ctx.storage.get<string>(KEYS.lastActivityAt),
      this.ctx.storage.get<number>(KEYS.expiryWindowMs),
    ])
    const lastSignalMs = Math.max(
      heartbeatAt === undefined ? 0 : Date.parse(heartbeatAt),
      lastActivityAt === undefined ? 0 : Date.parse(lastActivityAt),
    )
    const windowMs = expiryWindowMs ?? HEARTBEAT_MS
    // Fresh activity since the alarm was armed → the agent is alive; the
    // fired alarm is dropped (the next arm re-arms from the new signal).
    if (!expiryExpired(lastSignalMs, Date.now(), windowMs)) return
    await this.ctx.storage.put(KEYS.diedAt, new Date().toISOString())
    await this.writeSnapshot(runId, agentId)
  }

  // Activity-based expiry arming (M4 hook): the alarm fires windowMs after the
  // newest of heartbeatAt/lastActivityAt — or windowMs from now when the agent
  // has no signal yet. The window is persisted so the alarm handler can judge
  // "no activity since arming" without knowing the caller's window.
  private async armExpiry(windowMs: number): Promise<void> {
    const [heartbeatAt, lastActivityAt] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.heartbeatAt),
      this.ctx.storage.get<string>(KEYS.lastActivityAt),
    ])
    const lastSignalMs = Math.max(
      heartbeatAt === undefined ? 0 : Date.parse(heartbeatAt),
      lastActivityAt === undefined ? 0 : Date.parse(lastActivityAt),
    )
    await this.ctx.storage.put(KEYS.expiryWindowMs, windowMs)
    await this.ctx.storage.setAlarm(
      expiryArmTime(
        Number.isFinite(lastSignalMs) ? lastSignalMs : 0,
        windowMs,
        Date.now(),
      ),
    )
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
