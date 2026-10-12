# Game Task Hub V1.1

## Purpose

Game Task Hub is a lightweight local system for exactly one game per Tracker instance. It exposes task state, dependencies, milestone progress, owner/Agent handoffs, evidence and blockers without becoming a generic chat system or SaaS issue tracker.

## Authority and storage

V1 uses **managed CSV mode**. An instance owns one `tracker/task_tracker.csv`, the only current-state authority. The Hub validates its schema, locks and atomically replaces it after a matching revision check. Run files and optional event exports are durable mutation evidence, never a second current-state database.

The template has no game registry. A game clones this project into an independent `<Game>-Tracker` repository, initializes its own CSV, then keeps its game code repository separate. Template upgrades are code/docs/Skill/test synchronizations: they must never overwrite instance `tracker/`, `task-hub.config.json` or project-local configuration.

An Agent execution is a child **Run** under `tracker/task-records/<TaskID>/<TaskID>-Rnnnn/`. A Run carries technical evidence and can drive only its constrained task transition; it does not replace the CSV task workflow.

## V1 capabilities

- Dashboard with owner actions, current Agent work, blockers, run summaries, collapsible milestone groups and a separate all-task table.
- Packet API with a task, dependencies, reverse dependencies, prior Runs and the current `trackerRevision`.
- Same-origin, revision-checked owner feedback that records raw evidence and moves only owner-facing tasks to `Awaiting Agent Evaluation`.
- Ready-only managed Run lifecycle with monotonic allocation, bounded immutable UTF-8 artifacts, ordered events and crash-recoverable claim/close intents.
- Independent review lifecycle: a reviewer distinct from the Implementer claims an `In Review` task, then approves, rejects or blocks it with durable evidence.
- Pre-claim block endpoint for a contradictory/incomplete Ready packet; it records evidence but creates no Run.
- Generic dependency-unblock endpoint for unclaimed Blocked tasks whose direct dependencies are all Done. It does not encode project-specific Gate, release, decision or milestone policy.
- Repository-relative text artifact paths such as `logs/editor.log`; binary or large evidence remains a repository/HTTPS reference rather than an upload.

## Workflow safety rules

- Every mutation requires same-origin JSON and the revision returned by a current packet/tracker read. The Hub rejects stale writes rather than merging them heuristically.
- `Ready` is the only ordinary claimable task state. A Run claim moves only to `In Progress`; `verified` moves only to `In Review`; it never marks `Done`.
- `awaiting-human` requires the caller to explicitly name either `Awaiting Owner` or `Awaiting Owner Gate`. The template never infers workflow semantics from a task-ID prefix.
- Only the explicit review decision endpoint may set `Done`, and only after a distinct reviewer has claimed the In Review task. It does not unlock dependents.
- An interrupted pre-CSV claim is terminally `Abandoned` and reserves its Run ID. A close-intent is reconciled before later Run/review work so an `In Review` task with an unresolved active Run cannot be approved.
- The generic unblock endpoint proves only dependency completion plus absence of an active claim. A project coordinator remains responsible for its own Gate/release/decision policy before invoking it.
- The Hub refuses malformed CSV row widths and binds to loopback. LAN exposure, authentication, remote databases and binary uploads are out of scope.

## Acceptance

1. A fresh instance reads only its own configured CSV and presents all tasks by milestone.
2. Packet reads expose the data an Agent needs to decide whether a task is executable, without copying task state elsewhere.
3. Managed Run claim, event, artifact and close operations reject malformed, cross-origin, stale or inactive requests without rewriting the CSV.
4. Artifact paths may be safely nested, are immutable, and remain bounded per artifact and per Run.
5. A verified Run becomes `In Review`; a self-review or review with an active Run is rejected; only a claimed independent review can approve to `Done`.
6. Claim and close interruption recovery is deterministic and never reuses an allocated Run ID.
7. Generic pre-claim block and dependency-unblock transitions retain evidence but do not silently apply game-specific workflow policy.
8. `node scripts/start.mjs` selects a loopback port; `node scripts/test-managed-runs.mjs` verifies the Run/review/unblock contract in an isolated temporary Tracker.

## API contract

```text
GET  /api/tasks/<TaskID>/packet
POST /api/runs/start
POST /api/tasks/<TaskID>/runs/<RunID>/events
POST /api/tasks/<TaskID>/runs/<RunID>/artifacts
POST /api/tasks/<TaskID>/runs/<RunID>/close
POST /api/tasks/<TaskID>/review
POST /api/tasks/<TaskID>/block
POST /api/tasks/<TaskID>/unblock
POST /api/feedback
```

`/close` takes `outcome`, `summary`, current `trackerRevision`, and `blocker` for `blocked`. For `awaiting-human`, it additionally takes `ownerStatus` exactly equal to `Awaiting Owner` or `Awaiting Owner Gate`. `/review` first takes `{ action: "claim", reviewer }`, then `{ action: "decision", reviewer, decision, notes }`; a blocked decision also needs `blocker`. `/unblock` requires `agent` and a concrete `reason`; callers must perform project-specific eligibility checks before using it.
