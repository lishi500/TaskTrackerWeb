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
  const parsed = parseTaskSet(`Milestone: M2\r\n\r\n## S-A: Story\r\n- Acceptance: a\r\n\r\n### T-010：全角冒号标题\r\n- Type: Bug\r\n- Authority: owner\r\n- Depends: T-001； T-002、T-003, T-004 T-005\r\n- Priority: p2\r\n- Parent: S-OTHER\r\n- Milestone: M9\r\n- Stream: Audio\r\n- Spec: docs/x.md\r\n- Acceptance: 一行\r\n`.replace(/^/, '\uFEFF'));
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
  assert.match(all, /T-003: Authority must be 'reviewer', 'checks' or 'owner' \(got 'robot'\)/);
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

// ---- Authority: checks (RunEvidence) -------------------------------------------------------------------
{
  for (const spelling of ['checks', 'Checks', 'CHECK', 'RunEvidence', 'run-evidence', 'evidence']) {
    const parsed = parseTaskSet(`Milestone: M1\n## S-1: s\n- Acceptance: s\n### T-1: x\n- Authority: ${spelling}\n- Acceptance: y\n### T-2: review\n- Depends: T-1\n- Acceptance: z\n`);
    const plan = planImport(parsed, none);
    assert.deepEqual(plan.errors, [], spelling);
    const checks = plan.creates.find((item) => item.id === 'T-1').payload;
    assert.equal(checks.completionAuthority, 'RunEvidence', spelling);
    assert.equal(checks.ownerRole, 'Implementation agent');
    assert.equal(plan.creates.find((item) => item.id === 'T-2').payload.completionAuthority, 'IndependentReviewerAgent', 'the default stays reviewer');
  }
}

// ---- Review once per Story: a Story with checks Tasks needs an integration reviewer Task ---------------------
{
  const plan = (text, existing = none) => planImport(parseTaskSet(`Milestone: M1\n${text}`), existing);
  const story = '## S-1: Story\n- Acceptance: s\n';
  const task = (id, authority, depends = '') => `### ${id}: ${id}\n- Authority: ${authority}\n${depends ? `- Depends: ${depends}\n` : ''}- Acceptance: a\n`;
  const hub = (taskId, taskType, extra = {}) => [taskId, { taskId, taskType, status: 'Backlog', parentId: '', dependsOn: '', completionAuthority: 'IndependentReviewerAgent', ...extra }];
  const story1 = hub('S-1', 'Story', { completionAuthority: 'NotApplicable' });

  // the standard shape, direct and transitive coverage
  assert.deepEqual(plan(story + task('T-1', 'checks') + task('T-2', 'checks') + task('T-3', 'reviewer', 'T-1; T-2')).errors, []);
  assert.deepEqual(plan(story + task('T-1', 'checks') + task('T-2', 'checks', 'T-1') + task('T-3', 'reviewer', 'T-2')).errors, [], 'transitive: T-3 -> T-2 -> T-1');
  assert.deepEqual(plan(story + task('T-3', 'reviewer', 'T-2') + task('T-2', 'checks', 'T-1') + task('T-1', 'checks')).errors, [], 'document order does not matter');
  assert.deepEqual(plan(story + task('T-1', 'reviewer') + task('T-2', 'reviewer', 'T-1')).errors, [], 'a Story without checks Tasks has no extra rule');
  assert.deepEqual(plan(task('T-1', 'checks')).errors, [], 'a checks Task outside any Story has no Story to review');
  assert.deepEqual(plan(story + task('T-1', 'checks') + task('T-2', 'checks') + task('T-3', 'reviewer', 'T-1; T-2') + task('T-4', 'owner', 'T-3')).errors, [], 'an owner task after the review is fine');

  // violations: no reviewer, owner-only, partial coverage, wrong story
  let result = plan(story + task('T-1', 'checks') + task('T-2', 'checks'));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].line, 2, 'the error points at the Story heading');
  assert.equal(result.errors[0].message, "Story S-1 has checks Tasks (T-1, T-2) but no reviewer Task: add an integration-acceptance Task ('### ID: title' with '- Authority: reviewer' and '- Depends: T-1; T-2') so the Story gets its one independent review");

  result = plan(story + task('T-1', 'checks') + task('T-2', 'owner', 'T-1'));
  assert.match(messages(result).join(), /Story S-1 has checks Tasks \(T-1\) but no reviewer Task/, 'an owner decision is not an independent review');

  result = plan(story + task('T-1', 'checks') + task('T-2', 'checks') + task('T-3', 'reviewer', 'T-1'));
  assert.deepEqual(messages(result), ['Story S-1: no reviewer Task depends on all of its checks Tasks (T-3 is missing T-2); add them to its Depends']);

  result = plan(`${story}${task('T-1', 'checks')}## S-2: Other\n- Acceptance: s\n${task('T-9', 'reviewer', 'T-1')}`);
  assert.match(messages(result).join(), /Story S-1 has checks Tasks \(T-1\) but no reviewer Task/, 'a reviewer in another Story does not count as the S-1 integration Task');

  result = plan('## S-1: A\n- Acceptance: s\n' + task('T-1', 'checks') + '## S-2: B\n- Acceptance: s\n' + task('T-2', 'checks'));
  assert.equal(result.errors.length, 2, 'every violating Story is reported');
  assert.deepEqual(result.errors.map((problem) => problem.line), [2, 7]);

  // the graph includes the Hub: new checks Task under an existing Story, covered or not
  const existing = new Map([story1, hub('E-1', 'Task', { parentId: 'S-1', completionAuthority: 'RunEvidence' }), hub('E-2', 'Task', { parentId: 'S-1', dependsOn: 'E-1' })]);
  const addChecks = '### N-1: new\n- Parent: S-1\n- Authority: checks\n- Acceptance: a\n';
  result = plan(addChecks, existing);
  assert.match(messages(result).join(), /Story S-1: no reviewer Task depends on all of its checks Tasks \(E-2 is missing N-1\)/);
  assert.equal(result.errors[0].line, 2, 'an existing Story is reported at the first new child');
  assert.deepEqual(plan(`${addChecks}### N-2: integration\n- Parent: S-1\n- Depends: N-1; E-2\n- Acceptance: a\n`, existing).errors, [], 'a new integration Task covering old and new checks Tasks');
  assert.deepEqual(plan('### N-3: unrelated\n- Acceptance: a\n', existing).errors, [], 'a Story this import does not touch is left to tt doctor');
  assert.deepEqual(plan('### N-4: review only\n- Parent: S-1\n- Depends: E-1\n- Acceptance: a\n', new Map([story1, hub('E-1', 'Task', { parentId: 'S-1', completionAuthority: 'RunEvidence' })])).errors, [], 'a new reviewer Task completes an existing Story');
}

// ---- the planner's own example (worker L2, task-set-example.md) imports as written ---------------------------
{
  const plannerExample = `# Tasks: M2 Fishing Slice
Milestone: M2
Stream: Gameplay
Lane: slice
Spec: docs/milestones.md#m2

## M2-S1: F-01 Cast, wait and reel
- Acceptance: Running the project, one button takes the player from Idle through Cast, Wait, Bite and Reel to a Result card and back to Idle, repeatedly. A missed bite is harmless and each of the five fish pulls in a recognisably different way.
- Spec: docs/systems/cast-reel.md

### M2-T01: Reel mini-game with a tuning resource
- Authority: checks
- Priority: P0
- Acceptance: GUT tests drive the reel state machine through catch, escape and missed-bite paths with no dead end, and zone size, fill rate and drain rate load from a ReelTuning resource.
- Effort: M
- Profile: logic
- Why: F-01 - the reel-in moment is the experiment subject (DD-002).
- Decisions: DD-002, DD-003
- Uncertainty: LOW on code, HIGH on feel - the numbers need a human to play.
- Spec: docs/tech/cast-reel.md

### M2-T02: Five fish with distinct pull patterns
- Authority: checks
- Priority: P0
- Acceptance: A FishSpecies resource per fish (pull pattern, value, difficulty) and a catalog that a GUT test loads; for a fixed seed the steady, burst and drift patterns give distinct marker paths.
- Effort: S
- Profile: logic
- Why: F-02 - each reel must feel different (pillar 1, DD-002).
- Decisions: DD-002
- Spec: docs/tech/cast-reel.md

### M2-T03: Integrate and verify the fishing loop in the main scene
- Depends: M2-T01; M2-T02
- Authority: reviewer
- Priority: P0
- Acceptance: The main scene runs 300 frames headless with no engine errors, a smoke script completes ten cast, bite, reel, result cycles, every result writes one log line (fish, result, rod, seconds), and all five fish appear.
- Effort: S
- Profile: runtime
- Why: F-01, F-02 - integration-acceptance Task of M2-S1, the one independent review of the Story.
- Decisions: DD-002
- Spec: docs/tech/cast-reel.md

## M2-S2: F-04 Buy a better rod
- Acceptance: A player with enough coins buys the second rod at the shop and the next reel visibly plays differently (wider zone); the player can say what changed.
- Spec: docs/systems/rod-shop.md

### M2-T04: Rod shop with three rods that change the reel
- Depends: M2-T03
- Authority: reviewer
- Priority: P1
- Acceptance: The shop scene loads, buying deducts coins and swaps the active rod resource, and the reel reads the new parameters (GUT test plus a screenshot of the shop).
- Effort: M
- Profile: scene
- Why: F-04 - every purchase must visibly change the next cast (pillar 3, DD-004). The only implementation Task of its Story, so it is reviewer authority and doubles as the integration-acceptance Task.
- Decisions: DD-004
- Spec: docs/tech/rod-shop.md

### M2-T05: Owner playtest of the rod difference
- Depends: M2-T04
- Authority: owner
- Priority: P1
- Acceptance: The owner plays 20 catches with rod 1 and with rod 2 and records in docs/playtests/ whether the difference was felt and could be described.
- Effort: S
- Profile: scene
- Why: F-04 - whether a purchase is felt is a human judgement (DD-004).
- Decisions: DD-004
- Uncertainty: HIGH - taste.
`;
  const parsed = parseTaskSet(plannerExample, { docPath: 'docs/tasks/m2.md' });
  assert.deepEqual(parsed.errors, []);
  const plan = planImport(parsed, none);
  assert.deepEqual(plan.errors, [], 'the Story invariant holds for the planner example');
  assert.deepEqual(plan.creates.map((item) => [item.id, item.payload.completionAuthority]), [
    ['M2-S1', 'NotApplicable'], ['M2-S2', 'NotApplicable'],
    ['M2-T01', 'RunEvidence'], ['M2-T02', 'RunEvidence'], ['M2-T03', 'IndependentReviewerAgent'],
    ['M2-T04', 'IndependentReviewerAgent'], ['M2-T05', 'DecisionOwner'],
  ]);
  assert.equal(plan.creates.find((item) => item.id === 'M2-T03').payload.dependsOn, 'M2-T01;M2-T02');
  assert.equal(plan.creates.find((item) => item.id === 'M2-T01').payload.specRef, 'docs/tech/cast-reel.md');
  // turning the integration Task into a checks Task makes the same document invalid
  const broken = plannerExample.replace('Authority: reviewer\n- Priority: P0', 'Authority: checks\n- Priority: P0');
  assert.notEqual(broken, plannerExample);
  assert.match(messages(planImport(parseTaskSet(broken), none)).join(), /Story M2-S1 has checks Tasks \(M2-T01, M2-T02, M2-T03\) but no reviewer Task/);
}

console.log('taskset test passed: contract format, field variants, CJK/CRLF/BOM, error detection, ordering and skips, checks authority, Story review invariant.');
