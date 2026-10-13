---
name: game-task-hub
description: "Operate a local single-game TaskTrackerWeb instance as the sole task-state authority, including task packets, owner feedback, managed Agent Runs, independent review, durable evidence, and CSV safety rules."
---

# Game Task Hub

Use this skill when a request concerns a local TaskTrackerWeb instance, its task CSV, owner feedback workflow, Agent handoff, managed Agent Runs, or its connection to one game repository.

## What this tool is

TaskTrackerWeb is a lightweight, local task-management companion for **one game per Tracker instance**. The game code repository and the Tracker repository stay separate:

```text
<Game>/                         game code, assets, game-specific AGENTS.md
<Game>-Tracker/                 task state, evidence and TaskTrackerWeb
  tracker/task_tracker.csv      only current task-state source of truth
  tracker/task_events.jsonl     append-only task-state audit export
  tracker/task-records/         longer evidence and Agent Run records
```

Do not combine several games into one Tracker instance, and do not embed TaskTrackerWeb inside the game code repository. A Run is execution evidence under one task, not an independent task workflow; never maintain a second task status in the game repository, chat, or a Unity-specific tracker.

## Template and instance boundary

`TaskTrackerWeb` is the reusable template. Generic workflow, API, UI, validation, documentation, Skill and regression-test changes must be made, reviewed and committed in that template first. An instance may then receive an intentional one-way code/Skill/test sync.

Never copy an instance's `tracker/`, `task-hub.config.json`, task IDs, project name/branding, project-specific workflow policy, task records, evidence or local port into the template. Conversely, a template upgrade must not overwrite those instance-owned paths. If a problem is discovered while operating one game, first extract the smallest project-neutral rule and regression test in the template; keep any remaining game-specific policy in that game's repository or Tracker instance.

For an existing instance, first run `node scripts/sync-template.mjs --target <instance>` from the template to inspect the declared shared paths. Apply only with the explicit `--apply` form, then verify the instance. The synchronizer preserves `tracker/` and `task-hub.config.json` and refuses symlinks; never replace those protections with an ad-hoc bulk copy.

## Create a new Tracker instance

From a new clone of the TaskTrackerWeb template, run:

```bash
node scripts/init-instance.mjs --project-id <lowercase-id> --project-name "<Game name>"
node scripts/start.mjs
```

The initializer refuses to overwrite an existing `tracker/task_tracker.csv`. It copies `templates/task_tracker.skeleton.csv`; replace its four illustrative rows (`BACKLOG-001`, `DEC-001`, `IMPL-001`, `REV-001`) before treating the instance as actual project state.

To make this instance's current Skill available to Agents working inside the separate game repository, run once:

```bash
node scripts/link-game-skill.mjs /absolute/path/to/<Game>
```

This creates a symbolic link, so future updates to this instance's Skill apply immediately. Do not replace an existing game-local `game-task-hub` Skill without checking its owner and purpose.

`scripts/start.mjs` binds to loopback and chooses an available port by default. Use `PORT=<number>` only when a stable local URL is needed. Do not expose the unauthenticated service on a LAN or public network.

## First read

1. When working on the game, read that game's `AGENTS.md`, then retrieve `GET /api/tasks/<TaskID>/packet`.
2. When working on TaskTrackerWeb itself, read [README.md](../../../README.md) and [task_hub_product_spec.md](../../../task_hub_product_spec.md), then confirm no instance-specific name, task state, port, task-ID convention or project policy is entering the template.
3. Treat `tracker/task_tracker.csv` in the current Tracker instance as the current-state authority. Never use a copied browser view, chat summary, or another game's CSV as task truth.

## Operating boundary

- Use explicit workflow operations. Do not interpret an owner's raw feedback as `Done`, a decision, Gate approval, or dependency unlock.
- Read task dependencies and reverse dependencies before changing a task. Preserve historical Evidence and use the project's review-independence rules.
- `Blocked` is only for a task already admitted to the near-term chain that has a concrete actionable blocker. `Backlog` is planned but not yet admitted work; future-Milestone gating alone is Backlog, never Blocked. With `workflow.serialLane=true`, there may be one Agent task in `Ready`/`In Progress`/`In Review` and at most one armed direct successor in `Blocked`; every later link remains Backlog. Backlog capture is not claimable.
- A task reference may be an HTTPS URL or repository-relative path. Do not upload external/binary material or expose the loopback service without explicit authorization.
- Use the Hub API to allocate Run IDs, append events/artifacts, close technical outcomes and record independent review. Never edit `task_tracker.csv`, `run.json` or `events.jsonl` directly while the Hub is running.
- The Hub validates the complete `DependsOn` graph before every mutation and before it atomically writes a proposed update. It rejects unknown Task IDs, duplicate Task IDs, self/duplicate dependencies and cycles with `422`; do not work around that by directly editing the live CSV.
- For a planned external CSV migration or immediately after adding/removing tasks or changing `DependsOn` outside Hub APIs, call `GET /api/dependency-audit`. It remains readable for invalid CSV and returns deterministic `cycles` plus all structural defects. Fix the CSV deliberately, then re-run the audit; do not silently repair historical task meaning.

## Managed Agent Run

The task packet contains task scope, dependencies, existing Runs and `trackerRevision`. Only a `Ready` task can start a new Run. If goal/non-goals, Acceptance, SpecRef, dependency evidence, current blocker, state/availability, or required verification are absent or contradictory, do not start a Run; report the gap or use the project's authorized workflow to mark it blocked.

Use the Hub's loopback API only after reading the packet. All writes need `Content-Type: application/json` and `Origin: http://127.0.0.1:<port>`.

1. `POST /api/runs/start` with `taskId`, packet `trackerRevision`, `agent`, `verificationProfile`, and concise scope/expected-behavior fields. The Hub atomically assigns `TaskID-R0001`, creates its record and changes `Ready` only to `In Progress`. In serial mode it also arms the unique direct successor from Backlog to Blocked; it never exposes the rest of the chain.
2. Append an event at every material boundary through `POST /api/tasks/<TaskID>/runs/<RunID>/events`: preflight, baseline, change, verify, diagnose, repair, or escalation. Include a result and an evidence-based message; do not add repetitive no-information events.
3. Store bounded UTF-8 evidence through `.../artifacts`: `logs/editor.log`, `test-results.xml`, `evidence.md`, or a concise command/result log. For screenshots, builds or larger/binary data, write a repository-relative or HTTPS reference into `evidence.md` instead of uploading it.
4. Close through `.../close` with the latest `trackerRevision`, a summary and exactly one outcome:
   - `verified`: Hub moves the task to `In Review`, never `Done`.
   - `awaiting-human`: include `ownerStatus` exactly equal to `Awaiting Owner` or `Awaiting Owner Gate`; the Hub does not infer it from a task ID.
   - `blocked`: requires a concrete blocker and moves it to `Blocked`.
   - `incomplete`: leaves it `In Progress` and records the verification gap.

If a revision is stale, reload the packet and reconcile the newer owner/reviewer update; do not retry with the old revision. If another Run is active, do not compete for the task.

## Independent review and state maintenance

An independent reviewer, different from the CSV `Implementer`, reviews only an `In Review` task. First call `POST /api/tasks/<TaskID>/review` with `action: "claim"` and `reviewer`; then use the new revision to call it with `action: "decision"`, the same reviewer, `approved`, `rejected` or `blocked`, and review notes. A blocked decision also requires a concrete blocker. The Hub rejects self-review, unclaimed decisions and review while an active Run remains. Approval is the only route to `Done`; rejection returns the task to `Ready` while retaining review evidence.

For a contradictory/incomplete unclaimed Ready packet, use `POST /api/tasks/<TaskID>/block` with the current revision, agent, concrete blocker and evidence. It creates no Run. `POST /api/tasks/<TaskID>/unblock` is only a generic dependency transition: it requires a Blocked task with no active Run or review claim, all direct dependencies Done, an agent and a reason. A completed blocked Run's historical `Implementer` is not an active claim; a successful unblock clears it before returning the task to `Ready`. In serial mode, it rejects a new Ready task while another Agent task is Ready/In Progress/In Review.

Use `POST /api/tasks/<TaskID>/park` only to move an unclaimed, inactive `Blocked` task out of the near-term chain into `Backlog`, with a concrete scheduling reason. Use `POST /api/tasks/<TaskID>/admit` to move an unclaimed, inactive `Backlog` task back into the near-term chain: `targetStatus: Ready` requires every direct dependency Done and an empty serial lane; `targetStatus: Blocked` requires one active direct predecessor, all other dependencies Done, and a concrete blocker. These transitions are generic and do not decide whether a project Gate permits admission; enforce the game's Gate/release/decision rules first. After owner UI feedback, do not treat raw text as approval: a coordinator may use `/owner-evaluation` only after independently recording its assessment for a `ReviewRequired=No` task.

## Diagnostic logging

Prefer official Unity test, Console, runtime-state and build evidence. Use temporary in-game diagnostic logs only when they reveal a state that those mechanisms cannot expose. Every such log must be `Debug.LogWarning` with `[CyberBudda]`, Task ID, Run ID, expected/actual state and a specific check name. Copy the relevant output into the Run artifact, then remove the instrumentation before production delivery. A trace that merely says a method ran is not functional proof.

## References

- [README.md](../../../README.md): instance creation, launch and Skill linking.
- [task_hub_product_spec.md](../../../task_hub_product_spec.md): V1.1 task and Agent Run boundaries.
- [task_tracker.skeleton.csv](../../../templates/task_tracker.skeleton.csv): the 18-column task schema and illustrative workflow rows.
