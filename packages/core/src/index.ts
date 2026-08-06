// Hamilton Core — the Bun executor (HAMILTON.md §3).
// v0.0: HTTP API + SSE hub + status page skeleton, started via the CLI.

import { configureSync, getConsoleSink, getLogger } from "@logtape/logtape"

export interface CoreOptions {
  port?: number
}

export interface CoreHandle {
  url: string
  stop(): void
}

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

const logger = getLogger(["hamilton", "core"])

const VERSION = "0.0.0"

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>hamilton — ${VERSION}</title>
<style>
  body { background:#111; color:#ddd; font-family:ui-monospace,Menlo,monospace; font-size:14px; margin:2rem; }
  h1 { font-size:16px; color:#eee; }
  .dim { color:#666; }
  table { border-collapse:collapse; width:100%; margin-top:1rem; }
  td, th { text-align:left; padding:4px 12px 4px 0; border-bottom:1px solid #222; }
</style>
</head>
<body>
<h1>hamilton</h1>
<p class="dim">core booted — event spine lands in M1. live state, task graph, and agent table appear here.</p>
</body>
</html>`

function stream(): Response {
  const encoder = new TextEncoder()
  let ping: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      ping = setInterval(() => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "ping" })}\n\n`),
        )
      }, 5000)
    },
    cancel() {
      if (ping) clearInterval(ping)
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  })
}

export function startCore(options: CoreOptions = {}): CoreHandle {
  const port = options.port ?? 8787
  const server = Bun.serve({
    port,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/health") {
        return Response.json({ healthy: true, version: VERSION })
      }
      if (url.pathname === "/api/stream") {
        return stream()
      }
      if (url.pathname === "/") {
        return new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const url = `http://localhost:${server.port}`
  logger.info("Core listening on {url}", { url })
  return {
    url,
    stop: () => {
      logger.info("Core stopping")
      server.stop(true)
    },
  }
}
