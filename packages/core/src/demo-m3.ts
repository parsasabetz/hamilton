// M3 demo — the review gate end-to-end, offline (mock executor + fake reviewers):
//
//   run.planned (t2 depends on t1)
//     → t1 agent commits → ready_for_review
//     → RunDO review.start → dispatcher: detached review worktree + 2 mock
//       reviewer sessions (correctness, standards) → review.assigned
//     → reviewers submit: correctness FAILS (finding SEC-001) → DECIDE rejects
//       → review.verdict fail → t1 back in-progress + nudge
//     → t1 agent fixes + re-readies → FRESH gate → both reviewers pass
//     → approved → merge.execute → task.merged → t2 unblocks → same gate
//     → phase finished
//
// Asserts the full governance loop: reviewing status, structured findings,
// veto rejection, retry round, DAG order preserved, verdict events live.
//
// Run: bun packages/core/src/demo-m3.ts

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startCore } from "./index.ts"

const PORT = 8793
const RUN_ID = "m3-demo"
const PERSIST_DIR = ".mf-demo-m3"
const REVIEW_ROLES = ["correctness", "standards"]

let failures = 0

function check(name: string, ok: boolean, detail = ""): void {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  )
  if (!ok) failures += 1
}

function sh(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

interface Snapshot {
  phase?: string
  tasks?: Array<Record<string, unknown>>
  branches?: Array<Record<string, unknown>>
}

async function fetchSnapshot(): Promise<Snapshot> {
  const response = await fetch(
    `http://localhost:${PORT}/api/state?run=${RUN_ID}`,
  )
  const data = (await response.json()) as Record<string, unknown>
  return (data["snapshot"] as Snapshot) ?? {}
}

async function postEvent(
  type: string,
  taskId: string,
  agentId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await fetch(`http://localhost:${PORT}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, runId: RUN_ID, taskId, agentId, payload }),
  })
}

async function submitReviews(
  taskId: string,
  correctnessVerdict: "pass" | "fail",
): Promise<void> {
  for (let idx = 0; idx < REVIEW_ROLES.length; idx += 1) {
    await postEvent("review.submitted", taskId, `review-${taskId}-${idx}`, {
      reviewer: REVIEW_ROLES[idx]!,
      idx,
      verdict: correctnessVerdict,
      findings:
        correctnessVerdict === "fail"
          ? [
              {
                id: "SEC-001",
                location: `${taskId}.txt:1`,
                issue: "Demo finding: objective not met",
                suggested_fix: "Address the objective",
              },
            ]
          : [],
      checksRun: [
        { name: "typecheck", ok: true },
        { name: "tests", ok: true },
      ],
      summary: `${taskId} ${correctnessVerdict} (demo)`,
    })
    await Bun.sleep(120)
  }
}

async function fakeAgent(taskId: string, worktreePath: string): Promise<void> {
  writeFileSync(join(worktreePath, `${taskId}.txt`), `work for ${taskId}\n`)
  sh(worktreePath, ["add", `${taskId}.txt`])
  sh(worktreePath, ["commit", "-m", `feat(${taskId}): implement ${taskId}`])
  await postEvent("agent.claimed", taskId, `a-${taskId}`, {
    message: "brief read",
  })
  await postEvent("agent.milestone", taskId, `a-${taskId}`, {
    phase: "milestone",
    message: "implemented",
  })
  await postEvent("agent.ready_for_review", taskId, `a-${taskId}`, {
    summary: `${taskId} done`,
    branch: `feat/${taskId}`,
    checks: {},
  })
}

async function fakeAgentFix(
  taskId: string,
  worktreePath: string,
  round: number,
): Promise<void> {
  writeFileSync(join(worktreePath, `${taskId}-fix-${round}.txt`), "fixed\n")
  sh(worktreePath, ["add", `${taskId}-fix-${round}.txt`])
  sh(worktreePath, ["commit", "-m", `fix(${taskId}): address review findings`])
  await postEvent("agent.milestone", taskId, `a-${taskId}`, {
    phase: "milestone",
    message: `fix round ${round}`,
  })
  await postEvent("agent.ready_for_review", taskId, `a-${taskId}`, {
    summary: `${taskId} fixed`,
    branch: `feat/${taskId}`,
    checks: {},
  })
}

function branchRow(
  snapshot: Snapshot,
  branch: string,
): Record<string, unknown> | undefined {
  return (snapshot.branches ?? []).find(
    (row): row is Record<string, unknown> =>
      typeof row === "object" && row !== null && row["branch"] === branch,
  )
}

async function main(): Promise<void> {
  console.log(`M3 demo — review gate end-to-end (port ${PORT}, run ${RUN_ID})`)
  console.log("step 1: throwaway repo + clean persist dir")
  const repoRoot = mkdtempSync(join(tmpdir(), "hamilton-m3-demo-"))
  rmSync(PERSIST_DIR, { recursive: true, force: true })
  sh(repoRoot, ["init", "-b", "main"])
  sh(repoRoot, ["config", "user.email", "demo@hamilton.local"])
  sh(repoRoot, ["config", "user.name", "Hamilton Demo"])
  writeFileSync(join(repoRoot, "README.md"), "# demo repo\n")
  sh(repoRoot, ["add", "README.md"])
  sh(repoRoot, ["commit", "-m", "initial"])
  // Minimal constants layer so the dispatcher has reviewer instructions.
  mkdirSync(join(repoRoot, ".hamilton"), { recursive: true })
  writeFileSync(
    join(repoRoot, ".hamilton/reviewer-agent.md"),
    '---\ndescription: Read-only gate reviewer\ntype: agent\nmode: primary\npermission:\n  edit: deny\n  write: deny\n  apply_patch: deny\n  bash:\n    "*": deny\n    "git diff*": allow\n    "pnpm test*": allow\n    "pnpm typecheck*": allow\n    "pnpm format:check*": allow\n---\nYou are a reviewer in the Hamilton gate. You judge work; you never change it. Run the check process, write tests from the objective if missing, and file your review with the submit_review MCP tool (structured findings + verdict).\n',
  )

  console.log("step 2: boot core (mock executors, autonomous merges, gate on)")
  const handle = await startCore({
    port: PORT,
    persistDir: PERSIST_DIR,
    runId: RUN_ID,
    repoRoot,
    parent: "main",
    config: {
      mergeAuthority: "autonomous",
      provision: { install: "skip" },
      review: { roles: REVIEW_ROLES, vetoRoles: ["*"], maxRetries: 2 },
    },
    getTask: (taskId) => ({
      agent: "implementer",
      model: "mock/model",
      brief: `mock brief for ${taskId}`,
    }),
  })

  console.log("step 3: seed the DAG")
  await handle.emit({
    type: "run.planned",
    runId: RUN_ID,
    payload: {
      parent: "main",
      tasks: [
        {
          id: "t1",
          role: "implementer",
          zone: ["."],
          depends_on: [],
          status: "planned",
          on_failure: "retry-once",
          contract: { inputs: ["objective"], outputs: ["t1 feature"] },
          model: "mock/model",
          branch: "feat/t1",
        },
        {
          id: "t2",
          role: "implementer",
          zone: ["."],
          depends_on: ["t1"],
          status: "planned",
          on_failure: "retry-once",
          contract: { inputs: ["objective"], outputs: ["t2 feature"] },
          model: "mock/model",
          branch: "feat/t2",
        },
      ],
    },
  })

  console.log("step 4: drive — agents, reviewers, rejection round, merge")
  const mergedOrder: string[] = []
  const reviewRounds = new Map<string, number>() // taskId -> submissions sent
  const workDone = new Set<string>() // taskId -> initial work committed
  const awaitingVerdict = new Set<string>() // taskId -> gate round in flight
  let t1RejectedOnce = false
  const t2StartedBeforeT1Merged: boolean[] = []

  const driver = async (): Promise<void> => {
    while (true) {
      const snapshot = await fetchSnapshot()
      const tasks = snapshot.tasks ?? []
      for (const task of tasks) {
        const id = String(task["id"])
        const status = String(task["status"])
        if (status === "in-progress") {
          const rounds = reviewRounds.get(id) ?? 0
          const needsWork = rounds === 0 && !workDone.has(id)
          const needsFix =
            rounds > 0 && !mergedOrder.includes(`fix:${id}:${rounds}`)
          if (needsWork || needsFix) {
            const row = branchRow(
              snapshot,
              String(task["branch"] ?? `feat/${id}`),
            )
            if (row && typeof row["worktreePath"] === "string") {
              if (needsWork) {
                console.log(`  agent ${id}: initial work`)
                await fakeAgent(id, row["worktreePath"])
                workDone.add(id)
              } else {
                console.log(`  agent ${id}: fix round ${rounds}`)
                await fakeAgentFix(id, row["worktreePath"], rounds)
                mergedOrder.push(`fix:${id}:${rounds}`)
              }
            }
          }
        }
        if (status === "reviewing" && !awaitingVerdict.has(id)) {
          const rounds = reviewRounds.get(id) ?? 0
          const correctnessVerdict =
            id === "t1" && rounds === 0 ? "fail" : "pass"
          if (correctnessVerdict === "fail" && !t1RejectedOnce) {
            t1RejectedOnce = true
          }
          console.log(
            `  reviewers for ${id} round ${rounds + 1}: correctness=${correctnessVerdict}`,
          )
          awaitingVerdict.add(id)
          await submitReviews(id, correctnessVerdict)
          reviewRounds.set(id, rounds + 1)
        } else if (status !== "reviewing") {
          awaitingVerdict.delete(id)
        }
        if (status === "merged" && !mergedOrder.includes(id)) {
          mergedOrder.push(id)
          if (id === "t2") {
            t2StartedBeforeT1Merged.push(!mergedOrder.includes("t1"))
          }
        }
      }
      if (snapshot.phase === "finished" || snapshot.phase === "stopping") return
      // oxlint-disable-next-line no-await-in-loop -- deliberate poll loop
      await Bun.sleep(150)
    }
  }
  const driverPromise = driver()
  await driverPromise

  console.log("step 5: assertions")
  const snapshot = await fetchSnapshot()
  check("phase finished", snapshot.phase === "finished", String(snapshot.phase))
  check("t1 rejected at least once", t1RejectedOnce)
  check(
    "t1 went through two gate rounds",
    (reviewRounds.get("t1") ?? 0) >= 2,
    String(reviewRounds.get("t1")),
  )
  check("t2 gated once", (reviewRounds.get("t2") ?? 0) === 1)
  check(
    "merge order DAG-respecting",
    mergedOrder
      .filter((m) => !m.startsWith("agent:") && !m.startsWith("fix:"))
      .join(",") === "t1,t2",
    mergedOrder.join(","),
  )
  check(
    "t1 merged",
    (snapshot.tasks ?? []).find((t) => t["id"] === "t1")?.["status"] ===
      "merged",
  )
  check(
    "t2 merged",
    (snapshot.tasks ?? []).find((t) => t["id"] === "t2")?.["status"] ===
      "merged",
  )

  const tailResponse = await fetch(
    `http://localhost:${PORT}/api/events?run=${RUN_ID}&n=300`,
  )
  const tail = (await tailResponse.json()) as Array<Record<string, unknown>>
  const verdicts = tail.filter((e) => e["type"] === "review.verdict")
  check(
    "review.verdict events flowed",
    verdicts.length >= 3,
    String(verdicts.length),
  )
  check(
    "a fail verdict was emitted",
    verdicts.some(
      (v) => isRecord(v["payload"]) && v["payload"]["verdict"] === "fail",
    ),
  )
  const submitted = tail.filter((e) => e["type"] === "review.submitted")
  check(
    "review.submitted count (2+2+2)",
    submitted.length >= 6,
    String(submitted.length),
  )
  const assigned = tail.filter((e) => e["type"] === "review.assigned")
  check(
    "review.assigned fired per gate round",
    assigned.length >= 3,
    String(assigned.length),
  )
  const taskMerged = tail.filter((e) => e["type"] === "task.merged")
  check(
    "both merges in the tail",
    taskMerged.length === 2,
    String(taskMerged.length),
  )

  console.log("step 6: cleanup")
  await handle.stop()
  rmSync(PERSIST_DIR, { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })

  if (failures > 0) {
    console.log(`\nM3 demo: ${failures} FAILURE(S)`)
    process.exit(1)
  }
  console.log(
    "\nM3 demo: all checks passed — gate rejects with findings, agent fixes," +
      " fresh gate passes, merges land in DAG order, verdicts live on the bus",
  )
  process.exit(0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

await main()
