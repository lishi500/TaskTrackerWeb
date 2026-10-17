# Delivery context and evidence

Read when planning a slice, selecting verification, or preparing review/handoff. Use only the fields relevant to the claim; this format does not add another Hub status or mandatory API gate.

## Slice contract (SpecRef)

Keep one short contract for a coherent player outcome, referenced by its Story and executable tasks:

- Question or capability: what will become known or usable?
- Scope: initial state → real player action → visible result → next action; name the implemented rule subset and exclusions.
- Delivery lead: accountable for integration across technical tasks, not an indefinitely claimed parent task.
- Acceptance: key behavioral and technical checks, their independent expected results, target environment and reset method.
- Prerequisites: required product behavior, device/tool access and participant-facing materials.
- Budget/checkpoint: when to reassess, and which scope/product decisions require the owner.

An integration-acceptance Task can depend on implementation tasks. Never put its Story in DependsOn. Technical tasks can pass without proving the whole slice; make that limit explicit. A Bug captures a distinct defect, not every failed command during development.

## Evidence index (Run artifact)

```text
Task / Run / slice contract version:
Claim and acceptance items:
Code identity: commit, or saved diff plus untracked source/resource manifest
Build identity: artifact location and hash, when a build was tested
Environment: device/OS, scene/data/config and relevant settings
Check | actual entry point and input | expected | observed | evidence reference
Result and terminal tool status:
Unverified scope / failures / known limitations:
Reset and reproduction steps:
```

Reference binaries/screenshots/video in durable storage with an unambiguous repository/artifact identity. The Hub's text-artifact immutability does not make external references immutable or prove that they match the tested build. Avoid a temporary file as the only long-term proof.

## Match observations to claims

| Claim | Evidence to seek | Boundary to report |
| --- | --- | --- |
| Rule correctness | Critical state transitions and independent expected event/final-state results | Hash consistency alone does not prove the gameplay rule |
| Actual scene integration | Delivered scene/resources and startup path | Objects assembled only inside a test do not cover serialized scene bindings |
| Target-device operation | Platform input on the tested build/device and resulting state | Input injected by a test harness, or install/launch alone, cannot prove native input |
| Visible temporal behavior | Input, motion, impact and output over time, tied to logical state | Renderer flags, logs or one frame alone cannot prove the full visible sequence |
| Understanding or enjoyment | Real participant observations with protocol/build/sample boundaries | Agent opinions are not participant results |

Use inexpensive focused tests for local risks and integrated checks for the slice. Reviewers should check whether the tested entry point bypassed the layer being claimed and whether expected results were copied from the implementation. Separate successful compilation, local test results, device observations and human outcomes.

Before formal human validation, dry-run the actual build, clean materials, reset and collection procedure. Informal playtest notes remain informal; do not backfill them as preregistered results. If human operation is the only available device input, prepare the build and exact steps, retain responsibility for evidence, and label the execution method honestly.

## Reassessment note

At a repeated failure or agreed checkpoint, record only: what assumption failed, what evidence remains trustworthy, the smallest useful next step, and any actual owner decision needed. Keep a brief result/learning/cost note at slice completion. Do not turn these notes into a new chain of review/retro tickets.
