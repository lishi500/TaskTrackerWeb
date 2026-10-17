---
name: game-task-hub
description: "Track and deliver slice-level game work in the local Task Hub with the tt CLI: start/done, tasks that finish on a passing check, one review per Story, owner gates. Not for prototype tweaks or design docs, which need no ticket."
---

# Game Task Hub (`tt`)

The Hub owns task state; never edit `tracker/task_tracker.csv`, Run files or events by hand. Use only `tt` (game root: `tools/tt`, i.e. `node .claude/skills/game-task-hub/scripts/tt.mjs`; the forward slash works in PowerShell and Git Bash). It finds the tracker (`tt doctor` says how), starts the server, handles headers, revision and retries, keeps UTF-8 intact. Errors read `tt: what - why - try: command`.

## Standard flow
```text
tt import docs/tasks/<milestone>.md --admit-first   once per plan; existing ids are skipped
tt start [T-001]                no id = next claimable task; opens a Run, prints acceptance + spec
tt done ["what changed"]        attaches reports/last-check.md; no id = your one active Run; prints the next task
tt review T-009 approve|reject|block "notes" --as NAME     only the Story's integration task
```
`TT_AGENT=<your name>` (default `claude`). `tt event ID note ok "finding"` is optional.

## Who completes a task (`Authority:` in the plan, `--auth` in `tt new`)
- `checks` (ordinary implementation): `tt done` goes straight to Done when a check that ran after the Run started left `RESULT: PASS` in `reports/last-check.md`; `RESULT: FAIL` is refused (fix, run the check again). No review.
- `reviewer` (default; the Story's integration-acceptance task; risky or irreversible work such as save formats, migrations, public APIs): `tt done` -> In Review, one independent reviewer decides.
- `owner` (human decision, taste): `tt done` ends `awaiting-human`; after feedback `tt eval ID approve|resume|block|defer|return "notes"` (feedback is not approval; reviewer work can only `resume`).
- A Story with `checks` tasks needs a `reviewer` task depending on all of them (`tt import` refuses otherwise; `tt new` and `tt doctor` warn). It is reviewed once, through that task.

## Reviewing a Story
`tt show STORY` lists children (authority, Run, artifacts, auto-accepted) and the git diff range; `tt evidence ID [--name N]` prints an artifact (cut at 8 KB). Judge the Story's and the integration task's Acceptance against the diff and evidence. approve -> Done (the Story completes); reject -> Ready for another pass; block -> Blocked with the concrete obstruction. The reviewer differs from every agent that implemented the task (names compared ignoring case and spaces). Never review your own work or change a task's authority to skip review.

## Commands
| Need | Command |
| --- | --- |
| look | `tt next`; `tt status [--brief]`; `tt ls [--status S] [--milestone M] [--type T] [--parent ID]`; `tt show ID` |
| create one | `tt new ID "title" --accept "..." [--type Task\|Bug\|Story] [--parent S] [--deps "A;B"] [--auth checks\|reviewer\|owner] [--prio P1]` |
| move | `tt admit ID`; `tt park ID`; `tt block ID "why"`; `tt unblock ID` |
| evidence | `tt art ID NAME FILE\|-` (text <= 128 KB); `tt done ... --evidence FILE` (repeatable); `--no-evidence` opts out |
| not finished | `tt done ID "..." --outcome blocked --blocker "..."`; `--outcome incomplete`; `--outcome awaiting-human [--owner-status "Awaiting Owner Gate"]` |
| tool failure | `tt issue ID "summary" --key godot.headless.import-timeout --toolchain godot --op import` |
| server | `tt up`; `tt down`; `tt url`; `tt doctor`; `--json` = raw JSON; a `"@file.md"` text argument reads that file |

## What to track
- One task = one reviewable deliverable (about one pull request) with a player-observable Acceptance, not a ticket per step or retry. A Story is a scope container (never started or depended on).
- A distinct defect in finished work is a new Bug (`tt new BUG-1 "..." --type Bug --parent S-x --accept "..."`); never reopen or rewrite Done work.
- Prototype work (tuning, spikes, `Lane: prototype` task files) needs no ticket; `tt import` refuses those files. Plan the current slice in detail, later work coarsely. Payloads: references/api.md.

## Rules that keep the evidence honest
- Close `verified` only with a check that ran after the Run started. Say what it covers and what it does not; a compile, a unit test or one screenshot is not a player path. "Started" or 0 tests is not a pass. Format: references/delivery-evidence.md.
- Serial lane: one agent task (checks or reviewer) is Ready, In Progress or In Review at a time; `tt next` says what holds it. Start arms the successor, Done or approval advances it; a branching plan needs an explicit `tt admit`.
- Escalate to the owner only for product, scope, acceptance or budget changes or human-only access: facts, options, a recommendation, the smallest decision needed.
- After repeated failures of one kind stop retrying: diagnose, or `tt issue` (stable key, no paths or timestamps). Never lower the acceptance silently.

## More
references/api.md (HTTP, states, payloads); references/delivery-evidence.md (slice contract, evidence index); references/maintenance.md (init, link, discovery, upgrade)
