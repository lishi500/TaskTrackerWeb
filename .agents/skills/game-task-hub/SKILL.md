---
name: game-task-hub
description: "Operate or maintain a local single-game TaskTrackerWeb: plan Story/Task/Bug work, run and review tasks, handle owner feedback, preserve evidence, and report cross-task toolchain failures."
---

# Game Task Hub

Use the project's current Hub for task state. This skill coordinates delivery and evidence; it does not decide gameplay, execute Unity tooling, certify product quality, or authorize unrelated work.

## Find the right authority

- For game work, read its `AGENTS.md` and Tracker location, then retrieve `GET /api/tasks/<TaskID>/packet`. Read the task's SpecRef and resolved `packet.context.story` when present. Old handoff text and chat summaries are not current state.
- For template development, read [README](../../../README.md) and [product/API contract](../../../task_hub_product_spec.md). Generic changes belong in TaskTrackerWeb; game rules, task data and instance config stay in the game/instance.
- Each game has one separate Tracker instance. `tracker/task_tracker.csv` owns current task state; `tracker/task-records/<TaskID>/<RunID>/` holds execution evidence. `tracker/toolchain_issue_events.jsonl` owns toolchain reports/ACK history only.
- Read task/dependency state before mutations. Use Hub operations, never direct edits to the live CSV, Run manifests or event sources. Same-origin JSON is required for every write; task writes also need the current `trackerRevision`. On stale revision, reread and reconcile rather than blindly retry.

## Plan a deliverable without creating process noise

| Work item | Use | Boundary |
| --- | --- | --- |
| Story | Coherent feature scope or a future player outcome | Non-executable container: no ParentID/DependsOn, ReviewRequired=No; never claim, admit, review, or depend on it |
| Task | An independently verifiable delivery or technical prerequisite | May have a Story parent; acceptance defines the authorized outcome |
| Bug | A distinct defect/regression needing its own tracked correction | Uses the same dependency, Run and review workflow as Task |

Milestone is the delivery grouping, not a fourth TaskType. ParentID is scope context, not an execution dependency. Legacy CSV reads as Task until an explicit migration; do not reinterpret historical ParentID values as Story links.

Plan the current slice in detail and future work coarsely. A player-facing slice needs one accountable delivery lead and an executable integration-acceptance Task; technical child tasks may still be small. Completing children does not prove or auto-complete the Story's player outcome. Link the slice contract in SpecRef and put observable behavior in Acceptance; Story context never expands a child's scope by itself.

Keep diagnosis, attempted repairs and reruns within the current task when its contract still covers them. Create a Bug/Task for a distinct scope, independent dependency, or new defect in completed work. Do not create a ticket per command, thought or review step; independent review normally lives on the implementation task. Preserve old acceptance/evidence rather than rewriting history.

`ReviewRequired=No` is currently the convention for non-review owner work, not a supported Agent self-review switch. TaskType does not separate execution responsibility from review policy. Keep reviewed Agent Task/Bug work as Yes until that contract is explicitly changed.

## Execute and report what the evidence proves

1. Inspect the packet, dependency evidence, actual working tree and required environment/materials. Identify the player/technical result this work supports and its verification boundary. Read [evidence guidance](references/delivery-evidence.md) for slice planning, verification or handoff; it is a compact format, not another status database.
2. Only a Ready Task/Bug can start: `POST /api/runs/start` with `taskId`, revision, `agent`, `verificationProfile`, `scope`, and `expectedBehavior`. Hub allocates the Run ID. A missing/contradictory prerequisite can use pre-claim `/block`; routine investigation within authorized scope is Agent work, not automatically an owner decision.
3. Append material observations through the Run `/events` endpoint and store concise evidence through `/artifacts`. Do not record repetitive polling or hidden reasoning. Text artifacts are immutable and limited to 128 KB each, 32 files / 512 KB per Run. Put large/binary evidence in durable project/artifact storage and reference it with repository identity and build/hash information.
4. Close through `/api/tasks/<TaskID>/runs/<RunID>/close` using the latest revision, `summary`, and one outcome:
   - `verified` → In Review. This is the implementer's claim, not automatic evidence validation or Done.
   - `blocked` → Blocked; provide a concrete blocker.
   - `awaiting-human` → explicit `ownerStatus` of Awaiting Owner or Awaiting Owner Gate; explain the minimum human action actually required.
   - `incomplete` → remains In Progress with the Run still active; this does not release a claim or the serial lane.

Choose verification for the claim: pure logic, actual scene integration, target-device behavior, or human experience. Compilation, component tests or a screenshot alone cannot certify a complete player path. Poll asynchronous tests to their true terminal result; a start response or 0/0 is not a pass. Preserve unverified scope.

A distinct reviewer claims an In Review task through `/review`, then records approved/rejected/blocked with notes and current revision; blocked also needs a blocker. Do not impersonate independence by changing your own name. Review the acceptance's coverage as well as implementation/evidence. Approved becomes Done; rejected returns Ready; blocked preserves the actual obstruction.

## State and handoff rules

- Backlog is unadmitted work; Ready is claimable; Blocked is a specific near-term obstruction. Normal automatic dependency waits appear separately on the dashboard but retain CSV Blocked. Unknown/custom blocker reasons remain actionable.
- With serialLane enabled, only one reviewed Agent task can be Ready/In Progress/In Review. Start arms a unique direct successor; completion may advance one eligible successor. Ambiguous fan-out needs explicit coordinator selection. Do not keep an executable parent claimed while expecting children to run.
- Owner actions are Awaiting Owner / Awaiting Owner Gate. After feedback, Awaiting Agent Evaluation is **Agent work**, although the owner may supplement feedback. Raw input is not approval; coordinator `/owner-evaluation` resolves only non-review owner tasks after checking meaning. This is the separate owner-task route to Done.
- Run close requires an explicit ownerStatus. Automatic successor routing separately uses configured `ownerGateTaskPattern`; neither route proves project Gate eligibility.
- Technical choices and routine bugs stay with the Agent within existing authorization. Escalate actual product/scope/acceptance/budget changes or human-only access, giving facts, options, recommendation and the minimum requested decision. A tool report does not automatically require owner troubleshooting.
- Keep dynamic handoff state in the Hub. Link stable contracts and current packets; any saved snapshot must carry its time/revision and not become another editable activity list.

For creation, contract/dependency revision, park/admit/unblock, owner-wait and owner-evaluation payloads/eligibility, read the relevant section of the [API contract](../../../task_hub_product_spec.md). Read-only `/api/dependency-audit` remains available when malformed CSV blocks other operations. Do not bypass an audit failure by editing active state.

## Toolchain failure reporting and bounded recovery

Report a concrete infrastructure/tool failure with `POST /api/toolchain-issues`: `{ taskId, runId?, failureKey, reporter, toolchain, operation, summary, detail?, evidenceRef? }`. It uses its own event source and needs no tracker revision. Include the allocated Run when there is one; pre-claim incidents can omit it.

Use a stable failure-class key, such as `unity.cli.editor-play-timeout`, across comparable tasks. Keep timestamps, task IDs, paths and raw errors out of the key. Put the command/terminal-result evidence, affected verification and available fallback in detail/evidenceRef. Report actual failed attempts, not each poll of the same attempt; the displayed count is **reports**, not a proven count of unique root causes. Game assertion failures are not automatically toolchain incidents.

Repeated same-class failure without new evidence triggers diagnosis or an authorized alternative, not another identical retry. Multiple basic failures on one player path trigger a review of that path and its acceptance. Use the project's investigation budget/checkpoint; do not invent a universal two-failures owner gate. If a fallback cannot prove the same claim, retain the verification gap rather than silently lower acceptance.

ACK is owner acknowledgement/triage, not a fix or task completion. Do not ACK automatically just because you reported an issue. When authorized to ACK, read the issue first and POST `/api/toolchain-issues/<failureKey>/ack` with `{ acknowledger, notes, expectedReportCount: totalReportCount }`. Missing count is 400; if a new report arrived, 409 requires rereading and inspecting it before another ACK. History is preserved; recurrence `1 (5)` means one unacknowledged report after five previously acknowledged reports. Use `GET /api/toolchain-issues?includeAcknowledged=true` or the history toggle to inspect acknowledged issues. An unavailable health source is not proof of zero issues.

## Setup and maintenance (only when needed)

- New instance: use `node scripts/init-instance.mjs --project-id <id> --project-name "<name>"`, then `node scripts/start.mjs`; replace the illustrative skeleton rows before real use. The initializer refuses an existing tracker. Keep the unauthenticated service on loopback.
- Legacy schema: inspect current data, then use `POST /api/tracker/task-types/migrate` with `{ trackerRevision, actor, reason }`; it explicitly defaults old rows to Task and retains history. Do not migrate instances merely to inspect them.
- Link game skill: `node scripts/link-game-skill.mjs /absolute/path/to/game`; inspect an existing link's purpose before replacement.
- Upgrade instance: implement, validate and commit generic work in the template first. Preview `node scripts/sync-template.mjs --target <instance>`, apply only as part of an authorized upgrade with `--apply`, verify and restart as needed. Protect tracker/, instance config and local links. Template development alone does not imply a live game-instance rollout.
- Temporary testing logs, if needed, use warn with `[CyberBudda]` and must be removed before production. Use domain execution tools for runtime evidence; this Hub skill owns no game code or Unity test policy.
