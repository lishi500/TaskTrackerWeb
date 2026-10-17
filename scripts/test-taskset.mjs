#!/usr/bin/env node
// Unit tests for the task-set importer (skill scripts/taskset.mjs): parsing of the
// contract format and the pre-write plan (ordering, skips, error detection).

import assert from 'node:assert/strict';
import { isValidId, parseTaskSet, planImport, splitList } from '../.agents/skills/game-task-hub/scripts/taskset.mjs';

const none = new Map();
const exists = (...entries) => new Map(entries.map(([taskId, taskType]) => [taskId, { taskId, taskType, status: 'Backlog' }]));
const messages = (result) => result.errors.map((problem) => problem.message);

// ---- the documented format, comments included -------------------------------------------
const sample = `# Tasks: M1 原型
Milestone: M1
Stream: 玩法                      <!-- default Workstream, optional -->
Lane: slice                       <!-- slice | prototype -->
Spec: docs/milestones.md#m1       <!-- default SpecRef -->

## S-FISH: 抛竿与收线原型    <!-- "## ID: title" = Story -->
- Acceptance: 玩家按下抛竿键后鱼钩落水，
  按住收线键时浮标向岸边移动。
- Spec: docs/systems/cast-reel.md

### T-001: 抛竿动作与鱼钩落点
- Depends: -
- Authority: reviewer
- Priority: P0
- Acceptance: 按下 Space 后鱼钩沿抛物线飞出，落点出现水花。
- Effort: M
- Profile: runtime
- Why: 先有落点才能做收线
- Decisions: DD-001, DD-004

### T-002: 收线与上钩提示
- Depends: T-001
- Acceptance:
  - 按住 Space 浮标向岸边移动
  - 鱼上钩时浮标下沉
- Uncertainty: 手感参数需要试玩调整
- Notes: an unknown field is ignored and must not leak into Uncertainty or Acceptance
`;
{
  const parsed = parseTaskSet(sample, { docPath: 'docs/tasks/m1.md' });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.header, { milestone: 'M1', stream: '玩法', lane: 'slice', spec: 'docs/milestones.md#m1' });
  assert.deepEqual(parsed.items.map((item) => [item.id, item.kind, item.parent]), [['S-FISH', 'Story', ''], ['T-001', 'Task', 'S-FISH'], ['T-002', 'Task', 'S-FISH']]);
  const [story, first, second] = parsed.items;
  assert.equal(story.title, '抛竿与收线原型');
  assert.equal(story.acceptance, '玩家按下抛竿键后鱼钩落水，按住收线键时浮标向岸边移动。', 'wrapped CJK lines join without a space');
  assert.equal(story.authority, 'NotApplicable');
  assert.equal(story.ownerRole, 'Delivery lead');
  assert.equal(story.spec, 'docs/systems/cast-reel.md');
  assert.deepEqual([first.priority, first.authority, first.depends, first.acceptance], ['P0', 'IndependentReviewerAgent', [], '按下 Space 后鱼钩沿抛物线飞出，落点出现水花。']);
  assert.equal(second.priority, 'P1', 'default priority');
  assert.deepEqual(second.depends, ['T-001']);
  assert.equal(second.acceptance, '按住 Space 浮标向岸边移动; 鱼上钩时浮标下沉', 'a nested list collapses to one line');

  const plan = planImport(parsed, none);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.creates.map((item) => item.id), ['S-FISH', 'T-001', 'T-002']);
  assert.deepEqual(plan.creates[0].payload, {
    taskId: 'S-FISH', taskType: 'Story', parentId: '', milestone: 'M1', workstream: '玩法', task: '抛竿与收线原型',
    specRef: 'docs/systems/cast-reel.md', dependsOn: '', ownerRole: 'Delivery lead', priority: 'P1',
    acceptance: story.acceptance, completionAuthority: 'NotApplicable',
  });
  assert.equal(plan.creates[1].payload.specRef, 'docs/tasks/m1.md#t-001', 'Task SpecRef = <doc>#<lowercased id>');
  assert.equal(plan.creates[2].payload.dependsOn, 'T-001');
  assert.equal(plan.creates[1].payload.parentId, 'S-FISH');
  assert.equal(plan.creates[1].payload.completionAuthority, 'IndependentReviewerAgent');
  assert.equal(plan.creates[1].payload.ownerRole, 'Implementation agent');
}

// ---- field variants ------------------------------------------------------------------------
{
  const parsed = parseTaskSet(`Milestone: M2\r\n\r\n## S-A: Story\r\n- Acceptance: a\r\n\r\n### T-010：全角冒号标题\r\n- Type: Bug\r\n- Authority: owner\r\n- Depends: T-001； T-002、T-003, T-004 T-005\r\n- Priority: p2\r\n- Parent: S-OTHER\r\n- Milestone: M9\r\n- Stream: Audio\r\n- Spec: docs/x.md\r\n- Acceptance: 一行\r\n`.replace(/^/, '﻿'));
  assert.deepEqual(parsed.errors, []);
  const bug = parsed.items[1];
  assert.deepEqual([bug.id, bug.kind, bug.title, bug.authority, bug.ownerRole, bug.priority, bug.parent, bug.milestone, bug.stream, bug.spec],
    ['T-010', 'Bug', '全角冒号标题', 'DecisionOwner', 'Human decision owner', 'P2', 'S-OTHER', 'M9', 'Audio', 'docs/x.md']);
  assert.deepEqual(bug.depends, ['T-001', 'T-002', 'T-003', 'T-004', 'T-005']);
  assert.deepEqual(splitList('none'), []);
  assert.deepEqual(splitList(' 无 '), []);
  assert.deepEqual(splitList('A-1 ; B-2'), ['A-1', 'B-2']);
  const plan = planImport(parsed, exists(['S-OTHER', 'Story'], ['T-001', 'Task'], ['T-002', 'Task'], ['T-003', 'Task'], ['T-004', 'Task'], ['T-005', 'Task']));
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.creates.find((item) => item.id === 'T-010').payload.milestone, 'M9');
  assert.equal(plan.creates.find((item) => item.id === 'T-010').payload.workstream, 'Audio');
  assert.equal(plan.creates.find((item) => item.id === 'S-A').payload.workstream, 'General', 'default workstream');
  assert.equal(plan.creates.find((item) => item.id === 'S-A').payload.specRef, 'docs/tasks.md#s-a', 'no doc path known: generic fallback');
}
{
  const parsed = parseTaskSet('Milestone: M1\n## S-X: Learn C#\n- Acceptance: ok\n### T-1X: Task ## \n- Acceptance: fine\n');
  assert.equal(parsed.items[0].title, 'Learn C#', 'a "#" glued to the title is part of it');
  assert.equal(parsed.items[1].title, 'Task', 'a spaced closing ## is removed');
}
{
  const lane = parseTaskSet('Milestone: M0\nLane: prototype\n## S-P: x\n- Acceptance: y\n');
  assert.equal(lane.header.lane, 'prototype');
  assert.equal(parseTaskSet('Milestone: M0\nLane: weird\n').errors.length, 1);
}

// ---- parse errors ----------------------------------------------------------------------------
{
  const bad = parseTaskSet(`Milestone: M1
## S-OK: Story
- Acceptance: ok
- Depends: T-001
### T-001 Missing colon heading
- Acceptance: x
### T-002: No acceptance
### T-002: Duplicate id
- Acceptance: x
### T-003: Bad fields
- Acceptance: x
- Priority: urgent
- Authority: robot
- Depends: T-003; (after review)
- Type: Epic
### T-004: Story-ish
- Acceptance: x
- Parent: nonsense id
`);
  const all = messages(bad).join('\n');
  assert.match(all, /heading 'T-001 Missing colon heading' looks like an item but has no "ID: title" form/);
  assert.match(all, /S-OK: a Story cannot have Depends/);
  assert.match(all, /T-002: Acceptance is required/);
  assert.match(all, /T-002: duplicate id \(first used on line \d+\)/);
  assert.match(all, /T-003: Priority must be P0, P1, P2 or P3 \(got 'urgent'\)/);
  assert.match(all, /T-003: Authority must be 'reviewer' or 'owner' \(got 'robot'\)/);
  assert.match(all, /T-003: a task cannot depend on itself/);
  assert.match(all, /T-003: Depends entry '\(after' is not a task id \(separate several with ';'\)/);
  assert.match(all, /T-003: Type must be Task or Bug \(got 'Epic'\)/);
  assert.match(all, /T-004: Parent 'nonsense id' is not a task id/);
  assert.ok(bad.errors.every((problem) => problem.line > 0), 'every problem carries a line number');
  assert.equal(bad.errors.find((problem) => /Missing colon/.test(problem.message)).line, 5);
  assert.match(messages(parseTaskSet('Milestone: M1\n## ABC: x\n- Acceptance: y\n')).join(), /heading 'ABC: x': 'ABC' is not a usable id/);
  assert.match(messages(parseTaskSet('Milestone: M1\n### T-1: x\n- Acceptance: y\n- Type: Story\n')).join(), /Type must be Task or Bug/);
  assert.match(messages(parseTaskSet('Milestone: M1\n## S-1: x\n- Acceptance: y\n- Type: Bug\n')).join(), /a '## ' heading is a Story/);
}
assert.equal(isValidId('T-001'), true);
for (const id of ['t-001', 'T001', 'CON', 'T-', '-T', 'T-1.', 'T 1', `T-${'1'.repeat(130)}`]) assert.equal(isValidId(id), false, id);

// ---- plan errors and ordering --------------------------------------------------------------------
{
  const parsed = parseTaskSet(`Milestone: M1
## S-1: Story
- Acceptance: s
### T-B: declared first, depends on T-A and an existing task
- Depends: T-A; E-1
- Acceptance: b
### T-A: declared second
- Acceptance: a
### E-1: already in the Hub
- Acceptance: e
`);
  const plan = planImport(parsed, exists(['E-1', 'Task']));
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.skipped, ['E-1']);
  assert.deepEqual(plan.creates.map((item) => item.id), ['S-1', 'T-A', 'T-B'], 'Stories first, then dependencies before dependents');

  const problems = (text, existing = none) => messages(planImport(parseTaskSet(text), existing));
  assert.match(problems('Milestone: M1\n### T-1: x\n- Depends: T-9\n- Acceptance: y\n').join(), /T-1: depends on T-9, which is neither in this file nor in the Hub \(separate dependencies with ';'\)/);
  assert.match(problems('Milestone: M1\n## S-1: s\n- Acceptance: s\n### T-1: x\n- Depends: S-1\n- Acceptance: y\n').join(), /depends on S-1, a Story/);
  assert.match(problems('Milestone: M1\n### T-1: x\n- Parent: E-1\n- Acceptance: y\n', exists(['E-1', 'Task'])).join(), /Parent E-1 is a Task; a parent must be a Story/);
  assert.match(problems('Milestone: M1\n### T-1: x\n- Parent: S-9\n- Acceptance: y\n').join(), /Parent S-9 is neither in this file nor in the Hub/);
  assert.match(problems('Milestone: M1\n### T-1: a\n- Depends: T-2\n- Acceptance: y\n### T-2: b\n- Depends: T-3\n- Acceptance: y\n### T-3: c\n- Depends: T-1\n- Acceptance: y\n').join(), /dependency cycle among T-1, T-2, T-3/);
  assert.match(problems('## S-1: s\n- Acceptance: s\n').join(), /Milestone is required in the header/);
  assert.deepEqual(messages(planImport(parseTaskSet('## S-1: s\n- Acceptance: s\n'), none, { defaultMilestone: 'M7' })), []);
  // a dependency on an already-imported task is fine, and re-importing everything is a no-op
  const again = planImport(parseTaskSet('Milestone: M1\n### T-1: x\n- Acceptance: y\n'), exists(['T-1', 'Task']));
  assert.deepEqual([again.creates.length, again.skipped, again.errors.length], [0, ['T-1'], 0]);
}

console.log('taskset test passed: contract format, field variants, CJK/CRLF/BOM, error detection, ordering and skips.');
