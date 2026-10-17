# Hub HTTP cheat sheet

Use `tt` for everything in SKILL.md. Read this when you must call the API yourself (a payload `tt` does not cover, or debugging). The full contract is `task_hub_product_spec.md` in the template repository root.

## Rules for every call
- Base URL: the single line in `tracker/.tracker-url` (fixed per project; `tt url` prints it). Only `127.0.0.1`, `localhost` and `[::1]` are accepted as Host.
- POST needs `Content-Type: application/json` and `Origin: <base URL>` (any of the three loopback spellings with the same port). A missing Origin is a 403 that tells you what to send.
- Task writes need `trackerRevision` in the body: read it from `GET /api/health` (or any packet or list). Missing = 400 `revision-required`; stale = 409 `revision-stale` with `(current: X)`; re-read and retry. The revision is global, so any write by anyone makes yours stale.
- Every identity field names who acts: `agent` (most writes), `reviewer`, `actor`, `reporter`, `acknowledger`. `DependsOn` is one string joined by `;` (`"T-001;T-002"`), never commas.
- Bodies are UTF-8 JSON objects. On Windows build them in Node (`fetch` + `JSON.stringify`) or from a UTF-8 file: PowerShell 5.1 `curl.exe -d` and `Invoke-RestMethod` re-encode Chinese text and break quotes (the server answers 400 `bad-encoding` when it can tell).
```js
const base = (await import('node:fs')).readFileSync('tracker/.tracker-url', 'utf8').trim();
const { trackerRevision } = await (await fetch(`${base}/api/health`)).json();
await fetch(`${base}/api/tasks/T-001/admit`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ trackerRevision, agent: 'claude', targetStatus: 'Ready', reason: 'why' }) });
```

## Reads
| GET | Returns |
| --- | --- |
| `/api/health` | `{ok, tool, toolVersion, projectId, projectName, trackerRevision, serialLane, startedAt, pid, trackerError?}` (200 even when the tracker is unusable: `ok:false`) |
| `/api/tasks?status=&milestone=&type=&parent=&limit=` | `{trackerRevision, total, count, truncated, tasks:[{taskId, taskType, status, milestone, parentId, dependsOn, blocker, title, priority, completionAuthority, activeRun}]}`; `status` may be a comma list; unknown parameters are a 400 |
| `/api/next` | `{trackerRevision, next:{...task, acceptance, specRef}\|null, reason, blockedBy?}` |
| `/api/tasks/ID/packet` | task record, dependencies, reverse dependencies, Runs, `context.story` (parent Story) or `context.children` (for a Story) |
| `/api/tasks/ID/runs`, `/runs/RUN`, `/runs/RUN/artifacts/NAME` | Runs with artifact list; one Run with its events; one artifact (always served as text) |
| `/api/dependency-audit` | read-only graph report, always 200 (`valid:false` lists the problems) |
| `/api/summary`, `/api/tracker`, `/api/toolchain-issues[?includeAcknowledged=true]` | dashboard data (`/api/tracker` is large and unfiltered; prefer `/api/tasks`) |

## Writes (all POST, JSON body, plus `trackerRevision` unless noted)
| Path | Body | Effect |
| --- | --- | --- |
| `/api/tasks` | `agent, reason, newTask{taskId, taskType, parentId?, milestone, workstream, task, specRef, dependsOn, ownerRole, priority, acceptance, completionAuthority}` | creates a Backlog item (201). `taskType` Task/Bug/Story; authority `IndependentReviewerAgent`, `DecisionOwner`, or `NotApplicable` (Story only). A Story has no parent or dependencies; Task/Bug may have a Story parent and cannot depend on a Story |
| `/api/tasks/ID/admit` | `agent, targetStatus: Ready\|Blocked, reason, blocker?` | Backlog -> Ready (dependencies Done, lane free) or Blocked (single active predecessor) |
| `/api/tasks/ID/park` / `/unblock` | `agent, reason` | Blocked -> Backlog / Blocked -> Ready (dependencies Done, no active Run) |
| `/api/tasks/ID/block` | `agent, blocker, evidence` | Ready -> Blocked without a Run (contradictory or incomplete packet) |
| `/api/runs/start` | `taskId, agent, verificationProfile, scope, expectedBehavior` | Ready -> In Progress; allocates `ID-R0001`; arms the single successor in a serial lane |
| `/api/tasks/ID/runs/RUN/events` | `type, result, message` | append an event (Run must be active) |
| `/api/tasks/ID/runs/RUN/artifacts` | `name, content` | immutable text file, safe relative path, <= 128 KB each, 32 files / 512 KB per Run |
| `/api/tasks/ID/runs/RUN/close` | `outcome, summary, blocker?, ownerStatus?` | `verified` -> In Review (reviewer-authority only); `blocked` -> Blocked (needs `blocker`); `incomplete` -> stays In Progress; `awaiting-human` -> `ownerStatus` `Awaiting Owner` or `Awaiting Owner Gate` |
| `/api/tasks/ID/review` | `{action:"claim", reviewer}` then `{action:"decision", reviewer, decision: approved\|rejected\|blocked, notes, blocker?}` | approved -> Done (advances one eligible successor); rejected -> Ready; blocked -> Blocked. Reviewer must differ (normalized) from the Implementer and every Run agent |
| `/api/tasks/ID/contract` | `agent, reason, task, specRef, acceptance` | replace the contract trio of an unclaimed Backlog/Ready/Blocked task; history kept in Evidence |
| `/api/tasks/ID/dependencies` | `agent, reason, dependsOn` | replace the full list of an unclaimed Backlog/Blocked task; graph validated atomically |
| `/api/tasks/ID/owner-wait` | `agent, authorityTaskId, ownerStatus, reason` | the agent holding the active Run of a direct dependency exposes an unclaimed DecisionOwner Backlog task to the owner |
| `/api/tasks/ID/owner-evaluation` | `agent, decision: approved\|blocked\|deferred\|return-to-owner, notes, blocker?` | DecisionOwner task in `Awaiting Agent Evaluation` only (`tt eval`) |
| `/api/tasks/ID/owner-feedback-disposition` | `actor, action: resume\|blocked\|return-to-owner, reason, blocker?, ownerStatus?` | reviewer-authority task in `Awaiting Agent Evaluation`; `resume` needs dependencies Done and a free lane, then a new Run and review (`tt eval`) |
| `/api/feedback` | `taskId, feedback` | the owner's dashboard form: Awaiting Owner* -> `Awaiting Agent Evaluation` |
| `/api/toolchain-issues` | `taskId, runId?, failureKey, reporter, toolchain, operation, summary, detail?, evidenceRef?` | no revision; `failureKey` is a stable lowercase class such as `godot.headless.import-timeout` |
| `/api/toolchain-issues/KEY/ack` | `acknowledger, notes, expectedReportCount` | owner acknowledgement; count must equal the inspected `totalReportCount` (409 if it changed) |

## States
`Backlog` (planned) -> `Ready` (claimable) -> `In Progress` (active Run) -> `In Review` -> `Done`. `Blocked` = a concrete near-term obstruction; `Awaiting Owner` / `Awaiting Owner Gate` = the human acts; `Awaiting Agent Evaluation` = owner feedback needs an agent's decision; `Deferred` = owner deferred. A Story's status is derived: Done when it has Tasks and all are Done, else Backlog.

## Error codes (`code` in the JSON error)
`revision-required` 400, `revision-stale` 409, `locked` 409 (message names the holder; a dead holder or a lock older than 120 s is replaced automatically), `origin` 403, `host` 403, `content-type` 415, `bad-body` / `bad-json` / `bad-encoding` / `bad-url` / `bad-query` 400, `missing-field` 400 (names the fields), `invalid-field` / `field-too-long` / `artifact-too-large` 400, `body-too-large` 413, `identity-required` / `identity-invalid` 400, `invalid-id` 400 (also Windows device names such as `NUL`, `CON`, `COM1`), `invalid-dependency` 400, `unknown-dependency` 422, `reviewer-not-independent` 409, `duplicate-id` 409 (ids are unique ignoring case), `run-not-found` / `artifact-not-found` / `unknown-endpoint` 404, `tracker-missing` 503. Other 409s explain the state conflict in the message. A 500 with `EPERM`/`EBUSY` means another program held a tracker file; retry.
