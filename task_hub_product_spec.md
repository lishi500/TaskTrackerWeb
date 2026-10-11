# Game Task Hub V1.1

## Purpose

Game Task Hub is a lightweight local system for one game project per instance. It makes task state, dependencies, milestone progress, owner/Agent handoffs, evidence, and blockers visible without becoming a generic chat or SaaS issue tracker.

## Authority and storage

V1 uses **managed CSV mode**. Each Tracker instance owns one `tracker/task_tracker.csv` that remains its current-state source of truth. The Hub is the only supported writer when it is running; it validates the schema, uses an exclusive lock, checks the project revision, and atomically replaces the file. It may append a readable audit event log, but the log is evidence of mutations, not a second task-state database.

The template has no game registration list. A new game clones this project into an independent `<Game>-Tracker` repository and runs `scripts/init-instance.mjs`; its game code repository remains separate. The Hub must not silently import any tracker into a database or alter historical fields.

Task state and Agent execution state are intentionally different things. The CSV remains the only authority for the task workflow (`Ready`, `In Progress`, `In Review`, `Awaiting Owner Gate`, `Blocked`, `Done`, and so on). Each Agent execution is a child **Run** stored under `tracker/task-records/<TaskID>/<TaskID>-Rnnnn/`; a Run is evidence of work, never a second task-state machine.

V2 may add a SQLite runtime adapter only after an explicit migration task and owner approval. It must preserve task IDs, history, evidence and a Git-readable export.

## V1 capabilities

- Instance identity from local configuration and a tracker stored in the instance itself.
- Dashboard showing owner actions, ready Agent work, true blockers, current work, recent changes, and milestone progress.
- Collapsible milestone sections. The all-task table is a separate collapsed section.
- Dependency and reverse-dependency preview, navigable from task detail.
- Controlled owner feedback: feedback is raw evidence and only changes an owner-facing task to `Awaiting Agent Evaluation`.
- Backlog capture: creates a `BACKLOG-nnn` task in `Backlog` status. It is not claimable until triage explicitly changes it using the project workflow.
- Link/file-reference capture: appends a labelled HTTP(S) URL or repository-relative file reference to the task Evidence. V1 does not upload binary files.
- Health API reporting CSV schema, duplicate IDs, unknown/cyclic dependencies, Ready-with-undone dependencies, and blocker/claim inconsistencies.
- Read-only task packet API for Agent handoff.
- Managed Agent Run lifecycle: allocate an atomic per-task Run ID, append ordered execution events, retain bounded text artifacts, and close with a technical outcome.
- Run-aware task details showing the current/latest run, its verification profile, outcome, artifacts and event stream.

## V1 safety rules

- CSV task-workflow mutations require a matching project revision plus same-origin JSON requests. Run event/artifact appends are serialized under the same lock and require an active Run.
- Only the Hub allocates Run IDs. Agents must not scan `task-records/` to choose their own sequence or write the CSV directly.
- A Run may move a task only to `In Progress`, `In Review`, `Awaiting Owner Gate`, or `Blocked` by the fixed outcome mapping below. No Run operation may mark a task `Done`, approve a Gate, unlock a dependency, or accept a review.
- No endpoint may mark a task Done, approve a Gate, unlock a dependency, or accept a review merely because owner text was entered.
- `Backlog` and `Awaiting Agent Evaluation` are persisted workflow states. `Ready` remains the only ordinary claimable state.
- The service binds to loopback by default. LAN/cloud exposure, authentication and binary upload are out of scope.
- The tool refuses a tracker whose row widths do not match the header, rather than trying to repair it at write time.

## Acceptance

1. A freshly initialized instance loads its own CSV and the page groups every task by milestone.
2. Clicking a dependency or dependent opens a concise task preview without losing context.
3. An owner can submit feedback, create Backlog work and add an URL/file reference; each action has a revision check and audit line.
4. Stale revisions and cross-origin/non-JSON writes are rejected without modifying the CSV.
5. `GET /api/health` identifies structural errors without writes.
6. A new Agent can retrieve `GET /api/tasks/:taskId/packet` and receive scope, acceptance, dependencies, evidence, blocker and SpecRef.
7. It starts with `node scripts/start.mjs`, chooses a free loopback port by default, and can be packaged using the included Dockerfile; Docker execution is separately verified only where Docker is installed.
8. Starting a Run for a `Ready` task produces a monotonic ID such as `IMPL-042-R0003`, changes the task only to `In Progress`, and writes an auditable manifest and first event.
9. Closing a Run as `verified` moves the task to `In Review`, not `Done`; `awaiting-human` moves it to `Awaiting Owner Gate`; `blocked` requires a concrete blocker; `incomplete` remains `In Progress` with an explicit evidence gap.

## Agent Run contract

The Task Packet response includes the task, dependencies, dependents, prior Runs and the current `trackerRevision`. An Agent starts a Run with that exact revision. A stale revision is rejected so an Agent cannot silently overwrite an owner or reviewer update.

```text
POST /api/runs/start
POST /api/tasks/<TaskID>/runs/<RunID>/events
POST /api/tasks/<TaskID>/runs/<RunID>/artifacts
POST /api/tasks/<TaskID>/runs/<RunID>/close
```

Every Run contains `manifest.json` and `events.jsonl`. The Hub assigns event sequence numbers and stores bounded UTF-8 artifacts, such as `logs/editor.log`, `test-results.xml` and `evidence.md`. Screenshots, builds and other binary/large results remain repository-relative references in `evidence.md`; V1 does not accept binary upload.

Temporary Unity diagnostic logs are supporting evidence only: they must include Task ID, Run ID, expected/actual values and a `[CyberBudda]` marker at warn level, then be removed before production delivery. A log line does not prove behaviour by itself; it must be combined with the declared test, runtime state, screenshot or build evidence.
