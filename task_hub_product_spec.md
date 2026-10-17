# Game Task Hub V1.3

## Purpose

Game Task Hub is a lightweight local system for exactly one game per Tracker instance. It exposes task state, dependencies, milestone progress, owner/Agent handoffs, evidence and blockers without becoming a generic chat system or SaaS issue tracker.

## Authority and storage

V1 uses **managed CSV mode**. An instance owns one `tracker/task_tracker.csv`, the only current-state authority. The Hub validates its schema, locks and atomically replaces it after a matching revision check. Run files and optional event exports are durable mutation evidence, never a second current-state database. `tracker/toolchain_issue_events.jsonl` is separately authoritative only for append-only toolchain-health reports and acknowledgements; it never carries task status.

The template has no game registry. A game clones this project into an independent `<Game>-Tracker` repository, initializes its own CSV, then keeps its game code repository separate. Template upgrades are code/docs/Skill/test synchronizations: they must never overwrite instance `tracker/`, `task-hub.config.json` or project-local configuration.

An Agent execution is a child **Run** under `tracker/task-records/<TaskID>/<TaskID>-Rnnnn/`. A Run carries technical evidence and can drive only its constrained task transition; it does not replace the CSV task workflow.

## V1 capabilities

- Dashboard with owner actions, current Agent work, a Ready-only claimable-session panel, blockers, run summaries, collapsible milestone groups, nested Story → Task/Bug scope rows with direct-child completion progress and derived Story completion, and a separate all-task audit table.
- Instance metadata endpoint: the dashboard receives only the configured public project ID/name for its title; it does not embed a particular game's branding in the reusable template or expose instance task-state paths.
- Packet API with a task, dependencies, reverse dependencies, prior Runs and the current `trackerRevision`. `packet.context.story` contains the resolved parent Story's goal, acceptance, SpecRef and milestone (or null); `packet.context.children` lists a Story's direct Task/Bug children. This is read-only scope context, not another completion state or a dependency.
- Same-origin, revision-checked owner feedback that records raw evidence and moves only owner-facing tasks to `Awaiting Agent Evaluation`.
- Ready-only managed Run lifecycle with monotonic allocation, bounded immutable UTF-8 artifacts, ordered events and crash-recoverable claim/close intents.
- Independent review lifecycle: a reviewer distinct from the Implementer claims an `In Review` task, then approves, rejects or blocks it with durable evidence.
- Pre-claim block endpoint for a contradictory/incomplete Ready packet; it records evidence but creates no Run.
- Generic dependency-unblock endpoint for unclaimed Blocked tasks whose direct dependencies are all Done. It does not encode project-specific Gate, release, decision or milestone policy.
- Generic park/admit endpoints: `Blocked -> Backlog` removes future unscheduled work from active blocker monitoring; `Backlog -> Ready|Blocked` explicitly admits a task into the near-term chain without inferring milestone policy.
- Controlled owner-wait activation: the Agent holding an active authority Run may move one direct, unclaimed `DecisionOwner` `Backlog` dependency to an explicitly named owner-facing status. The Hub verifies the active authority Run and shared Agent identity; it never infers a milestone, task-ID convention, or completion state.
- Optional serial-lane controller (enabled by default for new instances): one `IndependentReviewerAgent` task may be `Ready`/`In Progress`/`In Review`; starting it arms only its unique direct successor, and a completed task advances only one uniquely eligible successor. Ambiguous fan-out remains `Backlog` for explicit admission.
- Controlled owner-evaluation endpoint: raw owner feedback remains `Awaiting Agent Evaluation` until an Agent records an auditable resolution for a `DecisionOwner` task.
- Controlled owner-feedback disposition endpoint: after owner feedback, an `IndependentReviewerAgent` Task/Bug receives an auditable `resume`, `blocked`, or `return-to-owner` disposition. Resume requires a fresh Run and independent review before Done.
- Controlled task-contract revision endpoint: an inactive unclaimed planned task may replace its `Task`, `SpecRef` and `Acceptance` together with a named Agent and reason, preserving history without permitting silent post-hoc reinterpretation.
- Controlled dependency-revision endpoint: an inactive unclaimed `Backlog` or `Blocked` task may replace its complete `DependsOn` list with a named Agent and concrete reason. The proposed full graph is atomically audited before write; admitted/active/reviewed/completed work cannot have dependencies rewritten.
- Controlled planned-task creation endpoint: a named Agent may add a complete, auditable `Backlog` task with a creation reason. The Hub validates the full proposed dependency graph atomically; creation never exposes a task as `Ready` or fabricates execution/review history.
- Work-item typing: `Task`, `Bug`, and non-executable `Story`. A Story holds scope only; its status is derived as `Done` exactly when it has one or more direct Task/Bug children and all are `Done`, otherwise `Backlog`. Task/Bug may name a Story parent and retain ordinary execution semantics. Milestone remains a grouping field, not a work-item type.
- Toolchain health board: Agents append Task/Run-linked reports with stable failure keys; the dashboard aggregates duplicate infrastructure failures across work, preserves all history, and lets an owner ACK only the current unacknowledged reports.
- Repository-relative text artifact paths such as `logs/editor.log`; binary or large evidence remains a repository/HTTPS reference rather than an upload.
- Dependency-graph audit endpoint: a deterministic, read-only report catches unknown or duplicate Task IDs, missing references, self/duplicate dependencies and dependency cycles before they become scheduling deadlocks.

## Workflow safety rules

- Every mutation requires same-origin JSON. Task mutations and schema migration additionally require the current tracker revision. Toolchain reports/ACKs use their separate event source and do not change the CSV revision; ACK requires an `expectedReportCount` from the issue the caller actually inspected.
- `Ready` is the only ordinary claimable task state. A Run claim moves only to `In Progress`; `verified` moves only to `In Review`; it never marks `Done`.
- Run close with `awaiting-human` requires explicit `Awaiting Owner` or `Awaiting Owner Gate`. Automatic successor routing separately uses the configured `ownerGateTaskPattern`; project eligibility remains the caller's responsibility.
- `CompletionAuthority` names the completion authority, not a permanent assigned Agent: `IndependentReviewerAgent` work reaches `Done` only through a claimed independent review; `DecisionOwner` work may reach `Done` through owner-evaluation after raw feedback; `NotApplicable` is Story-only. An `IndependentReviewerAgent` task in `Awaiting Agent Evaluation` cannot use owner-evaluation: it needs a disposition by an audited `actor`. There is no Coordinator role, assignee, or wait condition. In serial mode, completion can advance the single eligible direct successor. Story never participates in execution or these transitions.
- Owner action summaries contain only executable items in `Awaiting Owner` / `Awaiting Owner Gate`. `Awaiting Agent Evaluation` belongs in current Agent work; its detail still allows supplementary owner feedback. Summary `dependencyWaits` separates a provably automatic, currently valid one-hop wait from actionable `blockers`; the underlying CSV status stays Blocked. Unknown or changed blocker reasons remain actionable. Task counts are not product completion percentages.
- An interrupted pre-CSV claim is terminally `Abandoned` and reserves its Run ID. A close-intent is reconciled before later Run/review work so an `In Review` task with an unresolved active Run cannot be approved.
- The generic unblock endpoint proves only dependency completion plus absence of an active claim. A completed blocked Run may retain its historical `Implementer`; it is not an active claim, and a successful unblock clears that stale attribution before returning `Ready`. The caller remains responsible for its own Gate/release/decision policy before invoking it.
- Owner-wait activation is a narrow preparation transition, not a shortcut around review: it only accepts an unclaimed `DecisionOwner` `Backlog` task whose `DependsOn` directly includes an `In Progress` authority task with an active Run claimed by the named Agent. The caller supplies the exact owner-facing status and reason; the transition does not complete either task or unlock dependents.
- `Blocked` is an active execution obstruction with a concrete blocker; `Backlog` is planned but not yet admitted work. Future-milestone gating alone belongs in `Backlog`, not `Blocked`. With `workflow.serialLane=true`, an admitted `Blocked` task must be the unique immediate successor of an `In Progress`/`In Review` predecessor; later chain tasks remain `Backlog`. Park/admit operations require a current revision, a named Agent and reason, reject active Runs/review claims, and preserve an append-only Evidence line. Admission to `Ready` additionally verifies direct dependencies are Done and the lane is empty.
- The Hub refuses malformed CSV row widths and binds to loopback. LAN exposure, authentication, remote databases and binary uploads are out of scope.
- Every Hub mutation validates the current dependency graph before it changes workflow state; its shared atomic replacement path also validates the proposed post-mutation graph. This is mandatory for current state mutations and for any future add/delete/DependsOn-edit endpoint. An invalid graph returns `422` without replacing the CSV. `GET /api/dependency-audit` intentionally remains readable and returns `200` with `valid: false` and all detected errors, so external CSV edits can be diagnosed without bypassing the source-of-truth boundary.
- A task-contract revision is not a workflow shortcut: it accepts only `Backlog`, `Ready` or `Blocked` tasks with no active Run or review claim; it replaces the complete `Task`/`SpecRef`/`Acceptance` trio, requires at least one changed field and appends an auditable Evidence line. It cannot change a task's status, dependency graph, owner role, priority or review history. A completed or actively reviewed contract requires a distinct remediation task instead of revision.
- A dependency revision is not an admission shortcut: it accepts only `Backlog` or `Blocked` tasks with no active Run or review claim; a historical `Implementer` retained by a closed blocked Run is not an active claim. It replaces the complete semicolon-delimited `DependsOn` list, requires a changed list and appends old/new lists plus the reason to Evidence. It atomically rejects unknown IDs, self/duplicate edges and cycles, preserving the CSV on failure. It cannot revise an admitted `Ready`, active, reviewed or completed task.
- A planned-work-item creation is not an admission shortcut: it requires the standard 19-column tracker schema, a unique safe Task ID, complete task contract and named creation reason; its only initial status is `Backlog`. Unknown dependencies, duplicate Task IDs and dependency cycles fail the atomic mutation. The caller must separately apply project Gate policy and use `/admit` before the task can be claimed.
- A planned-work-item creation requires the standard 19-column schema including `TaskType` and `CompletionAuthority`. Story must have no parent/dependencies and use `NotApplicable`; Task/Bug must use `IndependentReviewerAgent` or `DecisionOwner`, may have only an existing Story as parent, and cannot depend on a Story. Story cannot enter admit, Run, review, block, owner-wait, evaluation or owner-feedback disposition transitions. Its status is a cached projection of direct Task/Bug completion: it is `Done` only when the direct child set is non-empty and all are `Done`, and returns to `Backlog` when a direct child is created. A read projects this without writing; the next authorized task mutation persists any correction with Evidence. The primary milestone view nests direct children below their Story, displays the direct `Done / total` count and excludes Story from operational status counts. This is scope completion, never product acceptance.
- `failureKey` identifies the failure class, not a single stack trace. ACK records the total reports seen at that moment; a later report becomes a new active count while the acknowledged count remains visible for recurrence context.

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
11. A contract revision rejects incomplete, unchanged, claimed or active-task edits; an allowed revision atomically retains status/history while recording the complete changed contract and reason.
12. Planned-work-item creation preserves a valid dependency graph, starts only in `Backlog`, records provenance and remains subject to normal admission.
13. A Story can organize child Task/Bug items but cannot be made executable; its derived `Done` tracks only direct-child scope completion and returns to `Backlog` when new direct work is planned; Milestone remains an independent grouping dimension.
14. Reports sharing a toolchain failure key aggregate across tasks; ACK clears only the active alert count, and a later report retains the acknowledged history.
15. Owner feedback cannot strand an executable task: `DecisionOwner` work is resolved through owner-evaluation; `IndependentReviewerAgent` work receives an auditable disposition to resume, block, or return it to an owner-facing state. Resume requires a fresh Run and independent review before `Done`.

## API contract

```text
GET  /api/instance
GET  /api/tasks/<TaskID>/packet
GET  /api/dependency-audit
GET  /api/toolchain-issues
POST /api/tracker/task-types/migrate
POST /api/tracker/completion-authority/migrate
POST /api/toolchain-issues
POST /api/toolchain-issues/<failureKey>/ack
POST /api/tasks
POST /api/runs/start
POST /api/tasks/<TaskID>/runs/<RunID>/events
POST /api/tasks/<TaskID>/runs/<RunID>/artifacts
POST /api/tasks/<TaskID>/runs/<RunID>/close
POST /api/tasks/<TaskID>/review
POST /api/tasks/<TaskID>/contract
POST /api/tasks/<TaskID>/dependencies
POST /api/tasks/<TaskID>/block
POST /api/tasks/<TaskID>/unblock
POST /api/tasks/<TaskID>/park
POST /api/tasks/<TaskID>/admit
POST /api/tasks/<TaskID>/owner-wait
POST /api/tasks/<TaskID>/owner-evaluation
POST /api/tasks/<TaskID>/owner-feedback-disposition
POST /api/feedback
```

`/close` takes `outcome`, `summary`, current `trackerRevision`, and `blocker` for `blocked`. For `awaiting-human`, it additionally takes `ownerStatus` exactly equal to `Awaiting Owner` or `Awaiting Owner Gate`. `/review` first takes `{ action: "claim", reviewer }`, then `{ action: "decision", reviewer, decision, notes }`; a blocked decision also needs `blocker`. `/unblock` requires `agent` and a concrete `reason`; callers must perform project-specific eligibility checks before using it. `/owner-evaluation` accepts `agent`, `decision` (`approved`, `blocked`, `deferred`, `return-to-owner`) and evidence-bearing `notes`; it is only available after owner feedback for `CompletionAuthority=DecisionOwner` work.

`/owner-feedback-disposition` accepts `{ trackerRevision, actor, action, reason, blocker?, ownerStatus? }`. It accepts only an unclaimed `CompletionAuthority=IndependentReviewerAgent` Task/Bug in `Awaiting Agent Evaluation`, with no active Run. `resume` additionally requires all direct dependencies `Done` and (when enabled) an empty serial lane; it moves to `Ready` and clears the feedback blocker and stale closed-Run `Implementer`. `blocked` requires a concrete `blocker` and moves to `Blocked`; `return-to-owner` requires `ownerStatus` of `Awaiting Owner` or `Awaiting Owner Gate`. Each outcome appends Evidence with its actor, action, time and reason. It never completes work, bypasses a new Run, or bypasses independent review.

`/owner-wait` accepts `authorityTaskId`, `agent`, `ownerStatus` (`Awaiting Owner` or `Awaiting Owner Gate`) and an evidence-bearing `reason`. The target must be unclaimed `DecisionOwner` `Backlog`; the authority must be its direct `In Progress` dependency and have an active Run claimed by the same Agent. It records the explicit transition only and never marks either task Done.

`/contract` accepts the current `trackerRevision`, `agent`, `reason` and a complete replacement `{ task, specRef, acceptance }`. It is allowed only for an inactive unclaimed `Backlog`, `Ready` or `Blocked` task and must change at least one of those three fields. It records which fields changed but preserves task state, dependencies and historical Evidence.

`/dependencies` accepts the current `trackerRevision`, `agent`, `reason` and complete replacement `{ dependsOn }`. It is allowed only for an unclaimed inactive `Backlog` or `Blocked` task and must change the complete semicolon-delimited list. The Hub validates the proposed full graph before atomically writing it and records old/new dependency lists plus the reason; it never changes status or makes a task claimable.

`POST /api/tracker/task-types/migrate` accepts current `trackerRevision`, `actor`, and `reason`, and upgrades a tracker that contains every legacy standard column but has no `TaskType`, inserting the column after `TaskID` while preserving additional columns. Every existing item is explicitly recorded as `Task`; it never infers historic parent relationships. A non-empty legacy `ParentID` is cleared and appended to Evidence as history, so the migrated tracker cannot silently treat it as a Story relationship.

`POST /api/tracker/completion-authority/migrate` accepts current `trackerRevision`, `actor`, and `reason` after TaskType migration. It replaces legacy `ReviewRequired` in place with `CompletionAuthority`: `Yes -> IndependentReviewerAgent`, `No -> DecisionOwner`, and Story -> `NotApplicable`, appending migration Evidence to every record. Canonical trackers reject both columns together.

`POST /api/tasks` accepts the current `trackerRevision`, `agent`, `reason` and `newTask`: `{ taskId, taskType, parentId?, milestone, workstream, task, specRef, dependsOn, ownerRole, priority, acceptance, completionAuthority }`. The server derives all workflow fields, creates only `Backlog`, records `CREATED` provenance, and atomically rejects malformed schema, invalid authority/type combinations, duplicate IDs or an invalid proposed dependency graph. The caller must use normal `/admit` after applying project-specific eligibility rules.

`POST /api/toolchain-issues` accepts a Task-linked report `{ taskId, runId?, failureKey, reporter, toolchain, operation, summary, detail?, evidenceRef? }`. `POST /api/toolchain-issues/<failureKey>/ack` requires `{ acknowledger, notes, expectedReportCount }`, with the inspected issue's positive integer `totalReportCount`. Missing/invalid count returns 400; a count mismatch under the event-source lock returns 409 without appending an event. No new reports to acknowledge also returns 409. Callers must reread and inspect new reports before another ACK, never silently retry with a newer count. Existing ACK clients must add this field. Both endpoints are same-origin JSON writes; neither needs or changes a tracker revision because neither mutates task state.

`GET /api/summary` retains task status counts and adds `executableCount`, `storyCount`, and `dependencyWaits`. `ownerActions` excludes Awaiting Agent Evaluation; `currentWork` includes it. `blockers` excludes only proven automatic one-hop dependency waits: an active direct predecessor, all other dependencies Done, no claim, the arm evidence and the unchanged generated blocker must agree. A historical arm marker alone must not drive hiding, automatic advancement or disarming of a later independent obstruction. A Story contributes to the total/grouping counts, never action queues.

The dashboard offers acknowledged-issue history and loads toolchain health independently from task data. An unavailable health source is displayed as unavailable, never zero issues. This separation creates no alternate task or incident state store.

Verification: `node scripts/test-delivery-context.mjs` covers completion authority, all owner-feedback dispositions, derived Story completion/reopen and dependency wait classification; the typed-work/toolchain suite covers the two-step schema migration, Story packet context and concurrent ACK protection. These are local isolated API checks, not evidence of game runtime correctness.
