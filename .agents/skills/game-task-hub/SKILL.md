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
2. When working on TaskTrackerWeb itself, read [README.md](../../../README.md) and [task_hub_product_spec.md](../../../task_hub_product_spec.md).
3. Treat `tracker/task_tracker.csv` in the current Tracker instance as the current-state authority. Never use a copied browser view, chat summary, or another game's CSV as task truth.

## Operating boundary

- Use explicit workflow operations. Do not interpret an owner's raw feedback as `Done`, a decision, Gate approval, or dependency unlock.
- Read task dependencies and reverse dependencies before changing a task. Preserve historical Evidence and use the project's review-independence rules.
- Backlog capture is not a claimable task. It needs explicit triage before it can become `Ready`.
- A task reference may be an HTTPS URL or repository-relative path. Do not upload external/binary material or expose the loopback service without explicit authorization.
- Use the Hub API to allocate Run IDs, append events/artifacts, close technical outcomes and record independent review. Never edit `task_tracker.csv`, `run.json` or `events.jsonl` directly while the Hub is running.
- If CSV structure is invalid, stop mutations and report the named structural issue. Do not silently repair historical task meaning.

## Managed Agent Run

The task packet contains task scope, dependencies, existing Runs and `trackerRevision`. Only a `Ready` task can start a new Run. If goal/non-goals, Acceptance, SpecRef, dependency evidence, current blocker, state/availability, or required verification are absent or contradictory, do not start a Run; report the gap or use the project's authorized workflow to mark it blocked.

Use the Hub's loopback API only after reading the packet. All writes need `Content-Type: application/json` and `Origin: http://127.0.0.1:<port>`.

1. `POST /api/runs/start` with `taskId`, packet `trackerRevision`, `agent`, `verificationProfile`, and concise scope/expected-behavior fields. The Hub atomically assigns `TaskID-R0001`, creates its record and changes `Ready` only to `In Progress`.
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

For a contradictory/incomplete unclaimed Ready packet, use `POST /api/tasks/<TaskID>/block` with the current revision, agent, concrete blocker and evidence. It creates no Run. `POST /api/tasks/<TaskID>/unblock` is only a generic dependency transition: it requires a Blocked task with no active Run or review claim, all direct dependencies Done, an agent and a reason. A completed blocked Run's historical `Implementer` is not an active claim; a successful unblock clears it before returning the task to `Ready`. Before calling it, enforce the current game's Gate, release and product-decision rules; the generic Hub intentionally has no task-ID-specific workflow policy.

## Diagnostic logging

Prefer official Unity test, Console, runtime-state and build evidence. Use temporary in-game diagnostic logs only when they reveal a state that those mechanisms cannot expose. Every such log must be `Debug.LogWarning` with `[CyberBudda]`, Task ID, Run ID, expected/actual state and a specific check name. Copy the relevant output into the Run artifact, then remove the instrumentation before production delivery. A trace that merely says a method ran is not functional proof.

## References

- [README.md](../../../README.md): instance creation, launch and Skill linking.
- [task_hub_product_spec.md](../../../task_hub_product_spec.md): V1.1 task and Agent Run boundaries.
- [task_tracker.skeleton.csv](../../../templates/task_tracker.skeleton.csv): the 18-column task schema and illustrative workflow rows.
