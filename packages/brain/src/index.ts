// Hamilton Brain — Miniflare/Workers code (HAMILTON.md §5).
// v0.0: RunDO skeleton with alarm pattern; worker entry dispatching to the DO.

import { DurableObject } from "cloudflare:workers"

export interface Env {
  RUN_DO: DurableObjectNamespace<RunDO>
}

const ALARM_MS = 60_000

export class RunDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/state") {
      return Response.json({
        phase: "planned",
        tasks: [],
        lastAlarm: await this.ctx.storage.get("lastAlarm"),
      })
    }
    return new Response("not found", { status: 404 })
  }

  override async alarm(): Promise<void> {
    // Alarms do not repeat — re-arm the next one (HAMILTON.md §5).
    await this.ctx.storage.put("lastAlarm", Date.now())
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS)
  }

  async armAlarm(delayMs: number = ALARM_MS): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/do/run")) {
      const id = env.RUN_DO.idFromName("run:default")
      return env.RUN_DO.get(id).fetch(request)
    }
    return new Response("hamilton brain ok", { status: 200 })
  },
} satisfies ExportedHandler<Env>
