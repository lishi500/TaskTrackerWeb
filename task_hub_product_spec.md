# Game Task Hub V1.1

## Purpose

Game Task Hub is a lightweight local system for exactly one game per Tracker instance. It exposes task state, dependencies, milestone progress, owner/Agent handoffs, evidence and blockers without becoming a generic chat system or SaaS issue tracker.

## Authority and storage

V1 uses **managed CSV mode**. An instance owns one `tracker/task_tracker.csv`, the only current-state authority. The Hub validates its schema, locks and atomically replaces it after a matching revision check. Run files and optional event exports are durable mutation evidence, never a second current-state database.

The template has no game registry. A game clones this project into an independent `<Game>-Tracker` repository, initializes its own CSV, then keeps its game code repository separate. Template upgrades are code/docs/Skill/test synchronizations: they must never overwrite instance `tracker/`, `task-hub.config.json` or project-local configuration.

An Agent execution is a child **Run** under `tracker/task-records/<TaskID>/<TaskID>-Rnnnn/`. A Run carries technical evidence and can drive only its constrained task transition; it does not replace the CSV task workflow.

## V1 capabilities

- Dashboard with owner actions, current Agent work, a Ready-only claimable-session panel, blockers, run summaries, collapsible milestone groups and a separate all-task table.
- Instance metadata endpoint: the dashboard receives only the configured public project ID/name for its title; it does not embed a particular game's branding in the reusable template or expose instance task-state paths.
- Packet API with a task, dependencies, reverse dependencies, prior Runs and the current `trackerRevision`.
- Same-origin, revision-checked owner feedback that records raw evidence and moves only owner-facing tasks to `Awaiting Agent Evaluation`.
- Ready-only managed Run lifecycle with monotonic allocation, bounded immutable UTF-8 artifacts, ordered events and crash-recoverable claim/close intents.
- Independent review lifecycle: a reviewer distinct from the Implementer claims an `In Review` task, then approves, rejects or blocks it with durable evidence.
- Pre-claim block endpoint for a contradictory/incomplete Ready packet; it records evidence but creates no Run.
- Generic dependency-unblock endpoint for unclaimed Blocked tasks whose direct dependencies are all Done. It does not encode project-specific Gate, release, decision or milestone policy.
- Generic park/admit endpoints: `Blocked -> Backlog` removes future unscheduled work from active blocker monitoring; `Backlog -> Ready|Blocked` explicitly admits a task into the near-term chain without inferring milestone policy.
- Controlled owner-wait activation: an active managed coordinator Run may move one of its direct, unclaimed non-review `Backlog` dependencies to an explicitly named owner-facing status. The Hub verifies the active authority Run and shared Agent identity; it never infers a milestone, task-ID convention, or completion state.
- Optional serial-lane controller (enabled by default for new instances): one Agent task may be `Ready`/`In Progress`/`In Review`; starting it arms only its unique direct successor, and a completed task advances only one uniquely eligible successor. Ambiguous fan-out remains `Backlog` for explicit coordinator admission.
- Controlled owner-evaluation endpoint: raw owner feedback remains `Awaiting Agent Evaluation` until an Agent records an auditable resolution for a non-review owner task.
- Repository-relative text artifact paths such as `logs/editor.log`; binary or large evidence remains a repository/HTTPS reference rather than an upload.
- Dependency-graph audit endpoint: a deterministic, read-only report catches unknown or duplicate Task IDs, missing references, self/duplicate dependencies and dependency cycles before they become scheduling deadlocks.

## Workflow safety rules

- Every mutation requires same-origin JSON and the revision returned by a current packet/tracker read. The Hub rejects stale writes rather than merging them heuristically.
- `Ready` is the only ordinary claimable task state. A Run claim moves only to `In Progress`; `verified` moves only to `In Review`; it never marks `Done`.
- `awaiting-human` requires the caller to explicitly name either `Awaiting Owner` or `Awaiting Owner Gate`. The template never infers workflow semantics from a task-ID prefix.
- Only the explicit review decision endpoint may set `Done`, and only after a distinct reviewer has claimed the In Review task. It does not unlock dependents.
- An interrupted pre-CSV claim is terminally `Abandoned` and reserves its Run ID. A close-intent is reconciled before later Run/review work so an `In Review` task with an unresolved active Run cannot be approved.
- The generic unblock endpoint proves only dependency completion plus absence of an active claim. A completed blocked Run may retain its historical `Implementer`; it is not an active claim, and a successful unblock clears that stale attribution before returning `Ready`. A project coordinator remains responsible for its own Gate/release/decision policy before invoking it.
- Owner-wait activation is a narrow preparation transition, not a shortcut around review: it only accepts an unclaimed non-review `Backlog` task whose `DependsOn` directly includes an `In Progress` authority task with an active Run claimed by the named Agent. The caller supplies the exact owner-facing status and reason; the transition does not complete either task or unlock dependents.
- `Blocked` is an active execution obstruction with a concrete blocker; `Backlog` is planned but not yet admitted work. Future-milestone gating alone belongs in `Backlog`, not `Blocked`. With `workflow.serialLane=true`, an admitted `Blocked` task must be the unique immediate successor of an `In Progress`/`In Review` predecessor; later chain tasks remain `Backlog`. Park/admit operations require a current revision, a named Agent and reason, reject active Runs/review claims, and preserve an append-only Evidence line. Admission to `Ready` additionally verifies direct dependencies are Done and the lane is empty.
- The Hub refuses malformed CSV row widths and binds to loopback. LAN exposure, authentication, remote databases and binary uploads are out of scope.
- Every Hub mutation validates the current dependency graph before it changes workflow state; its shared atomic replacement path also validates the proposed post-mutation graph. This is mandatory for current state mutations and for any future add/delete/DependsOn-edit endpoint. An invalid graph returns `422` without replacing the CSV. `GET /api/dependency-audit` intentionally remains readable and returns `200` with `valid: false` and all detected errors, so external CSV edits can be diagnosed without bypassing the source-of-truth boundary.

## Acceptance

1. A fresh instance reads only its own configured CSV and presents all tasks by milestone.
2. Packet reads expose the data an Agent needs to decide whether a task is executable, without copying task state elsewhere.
3. Managed Run claim, event, artifact and close operations reject malformed, cross-origin, stale or inactive requests without rewriting the CSV.
4. Artifact paths may be safely nested, are immutable, and remain bounded per artifact and per Run.
5. A verified Run becomes `In Review`; a self-review or review with an active Run is rejected; only a claimed independent review can approve to `Done`.
6. Claim and close interruption recovery is deterministic and never reuses an allocated Run ID.
7. Generic pre-claim block and dependency-unblock transitions retain evidence but do not silently apply game-specific workflow policy.
8. Serial mode exposes at most one active Agent task and only one armed successor; ambiguous branches and future work remain Backlog.
9. A dependency audit identifies malformed CSV structure, unknown/self/duplicate dependencies, duplicate Task IDs and deterministic cycle paths; normal reads and mutations reject an invalid graph without modifying it.
10. `node scripts/start.mjs` selects a loopback port; `node scripts/test-managed-runs.mjs`, `node scripts/test-serial-lane.mjs` and `node scripts/test-dependency-audit.mjs` verify isolated Run/review, serial-transition and dependency-integrity contracts.

## API contract

```text
GET  /api/instance
GET  /api/tasks/<TaskID>/packet
GET  /api/dependency-audit
POST /api/runs/start
POST /api/tasks/<TaskID>/runs/<RunID>/events
POST /api/tasks/<TaskID>/runs/<RunID>/artifacts
POST /api/tasks/<TaskID>/runs/<RunID>/close
POST /api/tasks/<TaskID>/review
POST /api/tasks/<TaskID>/block
POST /api/tasks/<TaskID>/unblock
POST /api/tasks/<TaskID>/park
POST /api/tasks/<TaskID>/admit
POST /api/tasks/<TaskID>/owner-wait
POST /api/tasks/<TaskID>/owner-evaluation
POST /api/feedback
```

`/close` takes `outcome`, `summary`, current `trackerRevision`, and `blocker` for `blocked`. For `awaiting-human`, it additionally takes `ownerStatus` exactly equal to `Awaiting Owner` or `Awaiting Owner Gate`. `/review` first takes `{ action: "claim", reviewer }`, then `{ action: "decision", reviewer, decision, notes }`; a blocked decision also needs `blocker`. `/unblock` requires `agent` and a concrete `reason`; callers must perform project-specific eligibility checks before using it. `/owner-evaluation` accepts `agent`, `decision` (`approved`, `blocked`, `deferred`, `return-to-owner`) and evidence-bearing `notes`; it is only available after owner feedback for `ReviewRequired=No` tasks.

`/owner-wait` accepts `authorityTaskId`, `agent`, `ownerStatus` (`Awaiting Owner` or `Awaiting Owner Gate`) and an evidence-bearing `reason`. The target must be unclaimed, non-review `Backlog`; the authority must be its direct `In Progress` dependency and have an active Run claimed by the same Agent. It records the explicit transition only and never marks either task Done.
