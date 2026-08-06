// Hamilton Brain — TaskDO: per-task state mirror, poked by RunDO on status
// transitions (HAMILTON.md §5).

import { DurableObject } from "cloudflare:workers"

import type { Env } from "./index.ts"
import { parseTaskStatus, readJsonBody } from "./run-do.ts"

const KEYS = {
  runId: "runId",
  taskId: "taskId",
  status: "status",
  updatedAt: "updatedAt",
  lastEventType: "lastEventType",
} as const

export class TaskDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/state") {
      return this.state()
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 })
    }
    if (url.pathname === "/transition") {
      const body = await readJsonBody(request)
      const status = parseTaskStatus(body?.status)
      if (status === undefined) {
        return new Response("invalid status", { status: 400 })
      }
      const { runId, taskId } = await this.identities()
      await this.ctx.storage.put({
        [KEYS.runId]: runId,
        [KEYS.taskId]: taskId,
        [KEYS.status]: status,
        [KEYS.updatedAt]: new Date().toISOString(),
      })
      return Response.json({ ok: true })
    }
    return new Response("not found", { status: 404 })
  }

  private async state(): Promise<Response> {
    const { runId, taskId } = await this.identities()
    const [status, updatedAt, lastEventType] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.status),
      this.ctx.storage.get<string>(KEYS.updatedAt),
      this.ctx.storage.get<string>(KEYS.lastEventType),
    ])
    return Response.json({
      runId,
      taskId,
      status: parseTaskStatus(status) ?? "planned",
      updatedAt,
      lastEventType,
    })
  }

  private async identities(): Promise<{ runId: string; taskId: string }> {
    const [storedRunId, storedTaskId] = await Promise.all([
      this.ctx.storage.get<string>(KEYS.runId),
      this.ctx.storage.get<string>(KEYS.taskId),
    ])
    if (storedRunId !== undefined && storedTaskId !== undefined) {
      return { runId: storedRunId, taskId: storedTaskId }
    }
    const name = this.ctx.id.name
    if (name !== undefined) {
      const parts = name.split(":")
      if (parts.length >= 3) {
        return { runId: parts[1] ?? "", taskId: parts.slice(2).join(":") }
      }
    }
    return { runId: "", taskId: "" }
  }
}
