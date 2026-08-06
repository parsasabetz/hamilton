// M2 demo — autonomous execution end-to-end, offline (mock executor):
//
//   run.planned (2-task DAG, t2 depends on t1)
//     → RunDO issues worktree.ensure (CORE binding)
//     → Core creates the worktree + chains session.start (mock session)
//     → task.dispatched
//     → a scripted agent commits real work in the worktree + declares
//       ready_for_review
//     → RunDO issues merge.execute (mergeAuthority: autonomous)
//     → Core squash-merges into the parent, emits task.merged
//     → t2 unblocks only after t1 merged (DAG order)
//     → phase "finished"
//
// The worktree watcher feeds real worktree.status_changed events throughout.
// Everything runs in a throwaway temp git repo; the hamilton repo is untouched.
//
// Run: bun packages/core/src/demo-m2.ts

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startCore } from "./index.ts"

const PORT = 8792
const RUN_ID = "m2-demo"
const PERSIST_DIR = ".mf-demo-m2"

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
  agents?: Array<Record<string, unknown>>
  branches?: Array<Record<string, unknown>>
}

async function fetchSnapshot(): Promise<Snapshot> {
  const response = await fetch(
    `http://localhost:${PORT}/api/state?run=${RUN_ID}`,
  )
  const data = (await response.json()) as Record<string, unknown>
  return (data["snapshot"] as Snapshot) ?? {}
}

async function fakeAgent(taskId: string, worktreePath: string): Promise<void> {
  console.log(`  fake agent ${taskId}: committing work in ${worktreePath}`)
  writeFileSync(join(worktreePath, `${taskId}.txt`), `work for ${taskId}\n`)
  sh(worktreePath, ["add", `${taskId}.txt`])
  sh(worktreePath, ["commit", "-m", `feat(${taskId}): implement ${taskId}`])
  for (const [type, payload] of [
    ["agent.claimed", { message: "brief read" }],
    ["agent.started", { message: "implementing" }],
    [
      "agent.milestone",
      { message: "implemented + committed", files: [`${taskId}.txt`] },
    ],
  ] as const) {
    await fetch(`http://localhost:${PORT}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        runId: RUN_ID,
        taskId,
        agentId: `a-${taskId}`,
        payload,
      }),
    })
    await Bun.sleep(150)
  }
  await fetch(`http://localhost:${PORT}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "agent.ready_for_review",
      runId: RUN_ID,
      taskId,
      agentId: `a-${taskId}`,
      payload: {
        summary: `${taskId} done`,
        branch: `feat/${taskId}`,
        checks: {},
      },
    }),
  })
  console.log(`  fake agent ${taskId}: ready_for_review declared`)
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
  console.log(`M2 demo — autonomous execution (port ${PORT}, run ${RUN_ID})`)
  console.log("step 1: throwaway repo + clean persist dir")
  const repoRoot = mkdtempSync(join(tmpdir(), "hamilton-m2-demo-"))
  rmSync(PERSIST_DIR, { recursive: true, force: true })
  sh(repoRoot, ["init", "-b", "main"])
  sh(repoRoot, ["config", "user.email", "demo@hamilton.local"])
  sh(repoRoot, ["config", "user.name", "Hamilton Demo"])
  writeFileSync(join(repoRoot, "README.md"), "# demo repo\n")
  sh(repoRoot, ["add", "README.md"])
  sh(repoRoot, ["commit", "-m", "initial"])

  console.log(
    "step 2: boot core (autonomous merges, installs skipped, mock sessions)",
  )
  const handle = await startCore({
    port: PORT,
    persistDir: PERSIST_DIR,
    runId: RUN_ID,
    repoRoot,
    parent: "main",
    config: {
      mergeAuthority: "autonomous",
      provision: { install: "skip" },
    },
    getTask: (taskId) => ({
      agent: "implementer",
      model: "mock/model",
      brief: `mock brief for ${taskId}`,
    }),
  })

  console.log("step 3: seed the DAG (t2 depends on t1)")
  await handle.emit({
    type: "run.planned",
    runId: RUN_ID,
    payload: {
      parent: "main",
      tasks: [
        {
          id: "t1",
          role: "implementer",
          zone: ["src"],
          depends_on: [],
          status: "planned",
          on_failure: "retry-once",
          contract: { inputs: ["demo"], outputs: ["t1 file"] },
          model: "mock/model",
          branch: "feat/t1",
        },
        {
          id: "t2",
          role: "implementer",
          zone: ["src"],
          depends_on: ["t1"],
          status: "planned",
          on_failure: "retry-once",
          contract: { inputs: ["demo"], outputs: ["t2 file"] },
          model: "mock/model",
          branch: "feat/t2",
        },
      ],
    },
  })

  console.log("step 4: drive the run — worktree → session → agent → merge")
  const dispatchOrder: string[] = []
  const mergeOrder: string[] = []
  const t2StartedBeforeT1Merged: boolean[] = []

  const driver = async (): Promise<void> => {
    while (true) {
      const snapshot = await fetchSnapshot()
      const phase = snapshot.phase
      const tasks = snapshot.tasks ?? []
      for (const task of tasks) {
        const id = String(task["id"])
        if (task["status"] === "in-progress" && !dispatchOrder.includes(id)) {
          dispatchOrder.push(id)
          if (id === "t2") {
            t2StartedBeforeT1Merged.push(!mergeOrder.includes("t1"))
          }
          const row = branchRow(
            snapshot,
            String(task["branch"] ?? `feat/${id}`),
          )
          if (row && typeof row["worktreePath"] === "string") {
            await fakeAgent(id, row["worktreePath"])
          } else {
            console.log(`  no worktree row yet for ${id}; retrying`)
            dispatchOrder.pop()
          }
        }
        if (
          task["status"] === "merged" &&
          !mergeOrder.includes(id) &&
          !dispatchOrder.includes(`${id}:merged`)
        ) {
          dispatchOrder.push(`${id}:merged`)
          mergeOrder.push(id)
        }
      }
      if (phase === "finished" || phase === "stopping") return
      // oxlint-disable-next-line no-await-in-loop -- deliberate poll loop
      await Bun.sleep(200)
    }
  }
  const driverPromise = driver()
  await driverPromise

  console.log("step 5: assertions")
  const snapshot = await fetchSnapshot()
  check("phase finished", snapshot.phase === "finished", String(snapshot.phase))
  check(
    "t1 merged before t2 dispatched",
    mergeOrder.includes("t1") && !t2StartedBeforeT1Merged.includes(true),
  )
  const t1Status = (snapshot.tasks ?? []).find((t) => t["id"] === "t1")?.[
    "status"
  ]
  const t2Status = (snapshot.tasks ?? []).find((t) => t["id"] === "t2")?.[
    "status"
  ]
  check("t1 merged", t1Status === "merged", String(t1Status))
  check("t2 merged", t2Status === "merged", String(t2Status))
  check(
    "merge order DAG-respecting",
    mergeOrder.join(",") === "t1,t2",
    mergeOrder.join(","),
  )
  const branches = snapshot.branches ?? []
  check(
    "two branch rows tracked",
    branches.length >= 2,
    String(branches.length),
  )
  const t1Branch = branchRow(snapshot, "feat/t1")
  check(
    "t1 branch shows commits (ahead >= 1)",
    typeof t1Branch?.["ahead"] === "number" && Number(t1Branch["ahead"]) >= 1,
    `ahead=${String(t1Branch?.["ahead"])}`,
  )

  const tailResponse = await fetch(
    `http://localhost:${PORT}/api/events?run=${RUN_ID}&n=200`,
  )
  const tail = (await tailResponse.json()) as Array<Record<string, unknown>>
  const statusEvents = tail.filter(
    (e) => e["type"] === "worktree.status_changed",
  )
  check(
    "worktree.status_changed events flowed",
    statusEvents.length >= 2,
    String(statusEvents.length),
  )
  check(
    "event tail covers the full loop",
    tail.some((e) => e["type"] === "task.merged"),
  )

  console.log("step 6: cleanup")
  await handle.stop()
  rmSync(PERSIST_DIR, { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })

  if (failures > 0) {
    console.log(`\nM2 demo: ${failures} FAILURE(S)`)
    process.exit(1)
  }
  console.log(
    "\nM2 demo: all checks passed — plan → worktrees → parallel agents → " +
      "DAG-ordered merges → live worktree graph",
  )
  process.exit(0)
}

await main()
