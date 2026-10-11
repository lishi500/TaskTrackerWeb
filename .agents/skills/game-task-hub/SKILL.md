---
name: game-task-hub
description: "Set up and operate a local single-game TaskTrackerWeb instance, including its CSV skeleton, owner feedback workflow, Agent Skill link, and managed-CSV safety rules."
---

# Game Task Hub

Use this skill when a request concerns a local TaskTrackerWeb instance, its task CSV, owner feedback workflow, Agent handoff, or its connection to one game repository.

## What this tool is

TaskTrackerWeb is a lightweight, local task-management companion for **one game per Tracker instance**. The game code repository and the Tracker repository stay separate:

```text
<Game>/                         game code, assets, game-specific AGENTS.md
<Game>-Tracker/                 task state, evidence and TaskTrackerWeb
  tracker/task_tracker.csv      current task-state source of truth
  tracker/task_events.jsonl     append-only audit export
  tracker/task-records/         longer evidence and file/link references
```

Do not combine several games into one Tracker instance, and do not embed TaskTrackerWeb inside the game code repository. Updating the TaskTracker template is a separate Git update for each Tracker instance.

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

1. When working on the game, read that game's `AGENTS.md`, selected task row, SpecRef and dependency evidence.
2. When working on TaskTrackerWeb itself, read [README.md](../../../README.md) and [task_hub_product_spec.md](../../../task_hub_product_spec.md).
3. Treat `tracker/task_tracker.csv` in the current Tracker instance as the current-state authority. Never use a copied browser view, chat summary, or another game's CSV as task truth.

## Operating boundary

- Use explicit workflow operations. Do not interpret an owner's raw feedback as `Done`, a decision, Gate approval, or dependency unlock.
- Read task dependencies and reverse dependencies before changing a task. Preserve historical Evidence and use the project's review-independence rules.
- Backlog capture is not a claimable task. It needs explicit triage before it can become `Ready`.
- A task reference may be an HTTPS URL or repository-relative path. Do not upload external/binary material or expose the loopback service without explicit authorization.
- The currently shipped UI/API supports tracker reading, summary and owner feedback. Future health, task-packet, link and backlog commands must not be claimed as available until implemented and tested.
- If CSV structure is invalid, stop mutations and report the named structural issue. Do not silently repair historical task meaning.

## Agent handoff

For implementation, request or assemble a task packet containing: goal/non-goals, Acceptance, SpecRef, dependency evidence, current blocker, state/availability, and required verification. If any of those is absent or contradictory, mark the work blocked rather than guessing. Owner feedback remains raw evidence until an authorized Agent evaluates it under the game's decision, Human Prep, or Gate process.

## References

- [README.md](../../../README.md): instance creation, launch and Skill linking.
- [task_hub_product_spec.md](../../../task_hub_product_spec.md): V1 product boundaries and future acceptance targets.
- [task_tracker.skeleton.csv](../../../templates/task_tracker.skeleton.csv): the 18-column task schema and illustrative workflow rows.
