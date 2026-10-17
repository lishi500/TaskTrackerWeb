---
name: game-task-hub
description: "Track and deliver slice-level game work in the local Task Hub with the tt CLI: next/start/done, independent review, evidence, owner gates. Not for prototype tweaks or design docs, which need no ticket."
---

# Game Task Hub (`tt`)

The Hub owns task state; never edit `tracker/task_tracker.csv`, Run files or events by hand. Use only `tt` (game root: `tools/tt`, i.e. `node .claude/skills/game-task-hub/scripts/tt.mjs`; the forward slash works in PowerShell and Git Bash). It starts the server, finds the URL, sends headers and the global revision, retries, keeps UTF-8 intact. Errors read `tt: what - why - try: command`.

## Standard flow (one task)
```text
tt start [T-001]                              no id = next claimable task; admits if needed, opens a Run, prints acceptance + spec
                                              (--profile logic|runtime|scene|package-config|build-export)
tt event T-001 note ok "finding"              optional; material observations only
tt done T-001 "changed X, verified Y"         -> In Review; attaches reports/last-check.md when newer than the Run
tt review T-001 approve|reject|block "notes"  independent reviewer only; approval prints the next task
```
`TT_AGENT=<your name>` (default `claude`). Reviews use a generated `reviewer-xxxx` or `--as NAME`.

## Commands
| Need | Command |
| --- | --- |
| look | `tt next` (what is ready, or why nothing is); `tt status [--brief]`; `tt ls [--status S] [--milestone M] [--type T] [--parent ID]`; `tt show ID` |
| import a plan | `tt import docs/tasks/<milestone>.md [--dry-run] [--admit-first]` (existing ids skipped; safe to re-run) |
| create one | `tt new ID "title" --accept "..." [--type Task\|Bug\|Story] [--parent S] [--deps "A;B"] [--auth reviewer\|owner] [--prio P1]` |
| move | `tt admit ID`; `tt park ID`; `tt block ID "why"`; `tt unblock ID` |
| evidence | `tt art ID NAME FILE\|-` (text <= 128 KB); `tt done ID "..." --evidence FILE` (repeatable); `--no-evidence` opts out |
| not finished | `tt done ID "..." --outcome blocked --blocker "..."`; `--outcome incomplete`; `--outcome awaiting-human [--owner-status "Awaiting Owner Gate"]` |
| owner feedback | `tt eval ID approve\|resume\|block\|defer\|return "notes"` (task shows `Awaiting Agent Evaluation`) |
| tool failure | `tt issue ID "summary" --key godot.headless.import-timeout --toolchain godot --op import` |
| server | `tt up`; `tt down`; `tt url`; `tt doctor`; `--json` = raw JSON; a `"@file.md"` text argument reads that file |

## What to track
- One task = one reviewable deliverable (about one pull request) with a player-observable Acceptance. Not a ticket per step, command, retry or review pass; diagnosis and repair stay inside the task while its contract covers them.
- A Story is a scope container (never started, reviewed or depended on); its Tasks/Bugs do the work. A distinct defect in finished work is a new Bug (`tt new BUG-1 "..." --type Bug --parent S-x --accept "..."`); never reopen or rewrite Done work.
- Prototype work (tuning, spikes, `Lane: prototype` task files) needs no ticket: use git and the checklist. `tt import` refuses prototype-lane files.
- Plan the current slice in detail, later work coarsely. Creation, contract and dependency payloads: references/api.md.

## Rules that keep the evidence honest
- Evidence: close `verified` only with a check that ran after the Run started (`reports/last-check.md` or `--evidence FILE`). Say what it covers and what it does not; a compile, a unit test or one screenshot is not a player path. Wait for async checks to finish; "started" or 0 tests is not a pass. Format: references/delivery-evidence.md.
- Review: the reviewer differs from every agent that implemented the task (names compared ignoring case and spaces; tt and the server both refuse). Judge the Acceptance's coverage, not only the diff. approve -> Done; reject -> Ready for another pass; block -> Blocked with the concrete obstruction. Never review your own work or change a task's authority to skip review.
- Owner gates: a `DecisionOwner` task ends `--outcome awaiting-human` (its default) with the decision needed. After owner feedback it shows `Awaiting Agent Evaluation`: read it (`tt show ID`), then `tt eval`; raw feedback is not approval, and reviewer-authority work can only `resume` (new Run + independent review).
- Serial lane: one reviewer-authority task at a time is Ready/In Progress/In Review; `tt next` says what holds it. Start arms the single successor, approval advances it; a branching plan needs an explicit `tt admit`.
- Escalate to the owner only for product, scope, acceptance or budget changes or human-only access: facts, options, a recommendation, the smallest decision needed. Routine bugs and technical choices are yours.
- After repeated failures of one kind stop retrying: diagnose, or `tt issue` (stable key, no paths or timestamps). Never lower the acceptance silently.

## More
references/api.md (HTTP, states, payloads); references/delivery-evidence.md (slice contract, evidence index); references/maintenance.md (init, start, link, upgrade, migration)
