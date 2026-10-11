---
name: game-task-hub
description: "Manage a locally deployed game-development Task Hub: inspect task packets, dependencies, milestones, owner feedback, evidence, and managed-CSV health without bypassing project workflow rules."
---

# Game Task Hub

Use this skill when a request concerns the local Game Task Hub instance, its task tracker, task handoff, owner feedback, or task health.

## First read

1. Read the project's `AGENTS.md` and the selected task's authoritative SpecRef.
2. Read `docs/task_hub_product_spec.md` when working on this Hub itself.
3. Inspect the Hub health endpoint before any mutation. Treat the configured project's tracker as authoritative in managed-CSV mode.

## Operating boundary

- Use explicit workflow operations. Do not interpret an owner's raw feedback as `Done`, a decision, Gate approval, or dependency unlock.
- Read task dependencies and reverse dependencies before changing a task. Preserve historical Evidence and use the project's review-independence rules.
- Backlog capture is not a claimable task. It needs triage before it can become `Ready`.
- A task reference may be an HTTPS URL or repository-relative path. Do not upload external/binary material or expose the loopback service without explicit authorization.
- If tracker health reports errors, stop mutations and report the named structural issue. Do not silently repair historical task meaning.

## Agent handoff

For implementation, request or assemble a task packet containing: goal/non-goals, Acceptance, SpecRef, dependency evidence, current blocker, state/availability, and required verification. If any of those is absent or contradictory, mark the work blocked rather than guessing.

## References

- For V1 data authority, commands, security and acceptance, read [the product specification](../../../docs/task_hub_product_spec.md).
