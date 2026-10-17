#!/usr/bin/env node
// "Review once per Story" end to end through tt: import with Authority: checks / reviewer, the Story
// invariant (import refuses, new warns, doctor lists), checks tasks that close to Done in two calls,
// the evidence pre-check, GITREV events, `tt show STORY`, `tt evidence`, and the one independent review.
// Also checks that the importer and the server agree on which Stories violate the invariant.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storyReviewErrors } from '../.agents/skills/game-task-hub/scripts/taskset.mjs';
import { call, createInstance, createSandbox, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const parent = join(tmpdir(), 'Hub story 测试');
mkdirSync(parent, { recursive: true });
const cleanEnv = { ...process.env };
for (const name of ['TT_URL', 'TT_DIR', 'TT_AGENT', 'TT_REVIEWER']) delete cleanEnv[name];
const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
if (!hasGit) console.log('note: git is not installed here, so the GITREV / diff range checks are skipped');

const instances = [];
const sandboxes = [];
const hubs = [];

const ttFor = (instance) => (args, { cwd, env = {}, input } = {}) => {
  const script = join(instance.root, '.agents', 'skills', 'game-task-hub', 'scripts', 'tt.mjs');
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv, ...env }, input });
  return { status: result.status, out: result.stdout, err: result.stderr, lines: result.stdout.split('\n').filter(Boolean) };
};
const ok = (result) => { assert.equal(result.status, 0, `exit ${result.status}: ${result.err}${result.out}`); return result; };
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

const planFile = `# Tasks: M1
Milestone: M1
Stream: Gameplay

## S-1: Cast and reel
- Acceptance: the player casts, reels and catches a fish

### T-1: Cast
- Authority: checks
- Acceptance: the hook lands in the water

### T-2: Reel
- Authority: checks
- Depends: T-1
- Acceptance: the bobber moves to the shore

### T-3: Integration acceptance
- Authority: reviewer
- Depends: T-2
- Acceptance: a fish can be caught from cast to reel
`;

await runSuite('tt-story', async () => {
  // ---- the importer and the server agree on the Story invariant ---------------------------------------------------------
  {
    const rows = (children) => [
      taskRow({ TaskID: 'S', TaskType: 'Story', CompletionAuthority: 'NotApplicable' }),
      ...children.map(([id, authority, depends = []]) => taskRow({ TaskID: id, ParentID: 'S', CompletionAuthority: authority, DependsOn: depends.join(';') })),
    ];
    const cases = {
      'checks only': [[['C-1', 'RunEvidence']], true],
      'checks + covering reviewer': [[['C-1', 'RunEvidence'], ['R-1', 'IndependentReviewerAgent', ['C-1']]], false],
      'transitive coverage': [[['C-1', 'RunEvidence'], ['C-2', 'RunEvidence', ['C-1']], ['R-1', 'IndependentReviewerAgent', ['C-2']]], false],
      'reviewer misses one': [[['C-1', 'RunEvidence'], ['C-2', 'RunEvidence'], ['R-1', 'IndependentReviewerAgent', ['C-1']]], true],
      'owner is not a reviewer': [[['C-1', 'RunEvidence'], ['O-1', 'DecisionOwner', ['C-1']]], true],
      'reviewer without dependency': [[['C-1', 'RunEvidence'], ['R-1', 'IndependentReviewerAgent']], true],
      'reviewers only': [[['R-1', 'IndependentReviewerAgent'], ['R-2', 'IndependentReviewerAgent', ['R-1']]], false],
      'one covering of two reviewers': [[['C-1', 'RunEvidence'], ['R-1', 'IndependentReviewerAgent', ['C-1']], ['R-2', 'IndependentReviewerAgent']], false],
      'coverage through another reviewer': [[['C-1', 'RunEvidence'], ['R-2', 'IndependentReviewerAgent', ['C-1']], ['R-1', 'IndependentReviewerAgent', ['R-2']]], false],
    };
    for (const [name, [children, violates]] of Object.entries(cases)) {
      const sandbox = await createSandbox('task-tracker-agree-', rows(children));
      sandboxes.push(sandbox);
      const hub = await startHub({ trackerPath: sandbox.trackerPath });
      hubs.push(hub);
      const serverGaps = (await call(hub.url, '/api/summary')).body.storyReview.gaps.map((gap) => gap.storyId);
      const items = [
        { id: 'S', kind: 'Story', parent: '', depends: [], authority: 'NotApplicable', line: 1 },
        ...children.map(([id, authority, depends = []]) => ({ id, kind: 'Task', parent: 'S', depends, authority, line: 2 })),
      ];
      assert.equal(serverGaps.length > 0, violates, `server: ${name}`);
      assert.equal(storyReviewErrors(items, new Map()).length > 0, violates, `importer: ${name}`);
    }
    // a dependency path through a task outside the Story counts for both
    const sandbox = await createSandbox('task-tracker-agree-', [
      taskRow({ TaskID: 'S', TaskType: 'Story', CompletionAuthority: 'NotApplicable' }),
      taskRow({ TaskID: 'C-1', ParentID: 'S', CompletionAuthority: 'RunEvidence' }),
      taskRow({ TaskID: 'X-1', DependsOn: 'C-1' }),
      taskRow({ TaskID: 'R-1', ParentID: 'S', DependsOn: 'X-1' }),
    ]);
    sandboxes.push(sandbox);
    const hub = await startHub({ trackerPath: sandbox.trackerPath });
    hubs.push(hub);
    assert.deepEqual((await call(hub.url, '/api/summary')).body.storyReview.gaps, []);
    const existing = new Map([['X-1', { taskId: 'X-1', taskType: 'Task', parentId: '', dependsOn: 'C-1', completionAuthority: 'IndependentReviewerAgent' }]]);
    const items = [
      { id: 'S', kind: 'Story', parent: '', depends: [], authority: 'NotApplicable', line: 1 },
      { id: 'C-1', kind: 'Task', parent: 'S', depends: [], authority: 'RunEvidence', line: 2 },
      { id: 'R-1', kind: 'Task', parent: 'S', depends: ['X-1'], authority: 'IndependentReviewerAgent', line: 3 },
    ];
    assert.deepEqual(storyReviewErrors(items, existing), []);
  }

  // ---- a real instance and a real game folder ----------------------------------------------------------------------------
  const instance = await createInstance({ parent, name: 'Tracker 故事 ', projectId: 'tt-story', projectName: 'Story Test' });
  instances.push(instance);
  const tt = ttFor(instance);
  const gameDir = mkdtempSync(join(parent, 'game '));
  for (const folder of ['docs/tasks', 'reports', 'plans', 'src']) mkdirSync(join(gameDir, folder), { recursive: true });
  writeFileSync(join(gameDir, 'docs', 'tasks', 'm1.md'), planFile);
  writeFileSync(join(gameDir, '.gitignore'), 'reports/\nplans/\n');
  let commitA;
  if (hasGit) {
    git(gameDir, 'init', '-q');
    git(gameDir, 'add', '-A');
    git(gameDir, 'commit', '-q', '-m', 'A');
    commitA = git(gameDir, 'rev-parse', 'HEAD');
  }
  const checkFile = join(gameDir, 'reports', 'last-check.md');
  // tt attaches reports/last-check.md only when it is newer than the Run: stamp it a few seconds ahead
  const stamp = (path) => { const future = new Date(Date.now() + 5_000); utimesSync(path, future, future); };
  const writeCheck = (text) => { writeFileSync(checkFile, text); stamp(checkFile); };

  // ---- tt import refuses a Story without its integration Task, before writing ---------------------------------------------
  const without = planFile.slice(0, planFile.indexOf('### T-3'));
  writeFileSync(join(gameDir, 'plans', 'no-review.md'), without);
  let result = tt(['import', 'plans/no-review.md'], { cwd: gameDir });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: import plans\/no-review\.md - 1 problem\(s\), nothing was written/);
  assert.match(result.err, /line 5: Story S-1 has checks Tasks \(T-1, T-2\) but no reviewer Task: add an integration-acceptance Task \('### ID: title' with '- Authority: reviewer' and '- Depends: T-1; T-2'\)/);
  writeFileSync(join(gameDir, 'plans', 'partial.md'), planFile.replace('- Depends: T-2\n- Acceptance: a fish', '- Depends: T-1\n- Acceptance: a fish'));
  result = tt(['import', 'plans/partial.md', '--dry-run'], { cwd: gameDir });
  assert.equal(result.status, 1, 'a dry run reports the same problem');
  assert.match(result.err, /Story S-1: no reviewer Task depends on all of its checks Tasks \(T-3 is missing T-2\); add them to its Depends/);
  assert.equal(ok(tt(['ls'], { cwd: gameDir })).out.trim(), '(no tasks match)', 'nothing was written');
  writeFileSync(join(gameDir, 'plans', 'bad-authority.md'), planFile.replace('Authority: checks\n- Acceptance: the hook', 'Authority: robot\n- Acceptance: the hook'));
  assert.match(tt(['import', 'plans/bad-authority.md'], { cwd: gameDir }).err, /T-1: Authority must be 'reviewer', 'checks' or 'owner' \(got 'robot'\)/);

  // ---- the valid plan, checks task in two calls -----------------------------------------------------------------------------
  result = ok(tt(['import', 'docs/tasks/m1.md', '--admit-first'], { cwd: gameDir }));
  assert.deepEqual(result.lines, [
    'imported docs/tasks/m1.md: created 4 (1 Story, 3 Task, 0 Bug), skipped 0 existing',
    'created: S-1 T-1 T-2 T-3',
    'admitted: T-1 (Ready) - tt start T-1',
  ]);
  const authorities = Object.fromEntries(JSON.parse(ok(tt(['ls', '--json'], { cwd: gameDir })).out).tasks.map((task) => [task.taskId, task.completionAuthority]));
  assert.deepEqual(authorities, { 'S-1': 'NotApplicable', 'T-1': 'RunEvidence', 'T-2': 'RunEvidence', 'T-3': 'IndependentReviewerAgent' });

  result = ok(tt(['start'], { cwd: gameDir }));
  assert.equal(result.lines[0], 'started T-1: run T-1-R0001, profile logic, agent claude');
  assert.match(result.out, /^completes on: a passing project check \(tt done attaches reports\/last-check\.md with "RESULT: PASS"\); no review$/m);
  const eventsOf = async (taskId, runId) => (await call(instance.url, `/api/tasks/${taskId}/runs/${runId}`)).body.events;
  if (hasGit) assert.deepEqual((await eventsOf('T-1', 'T-1-R0001')).filter((event) => event.type === 'GITREV').map((event) => event.message), [`base=${commitA}`], 'tt start records the git HEAD');

  // evidence pre-checks happen before anything is uploaded
  result = tt(['done', 'built the cast'], { cwd: gameDir });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-1 cannot be closed as verified without evidence - no --evidence file and no reports\/last-check\.md/);
  writeCheck('# Check\n[PASS] parse\nRESULT: FAIL (test: 2 failed)\n');
  result = tt(['done', 'built the cast'], { cwd: gameDir });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-1 cannot close as verified: last-check\.md says "RESULT: FAIL \(test: 2 failed\)" - a Run with a failing check is refused - try: fix the failure and run the project check again; or tt done T-1 "why" --outcome incomplete/);
  assert.deepEqual((await call(instance.url, '/api/tasks/T-1/runs/T-1-R0001')).body.run.artifacts, [], 'a failing check is never uploaded');
  assert.equal((await call(instance.url, '/api/tasks/T-1/packet')).body.task.Status, 'In Progress');
  writeCheck('# Check\nall fine\n');
  result = tt(['done', 'built the cast'], { cwd: gameDir });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-1 cannot close as verified: no evidence file has a line matching \^RESULT: PASS\\b - this task completes on a passing check - try: run the project check so reports\/last-check\.md contains "RESULT: PASS", or tt done T-1 "what is missing" --outcome incomplete/);
  assert.deepEqual((await call(instance.url, '/api/tasks/T-1/runs/T-1-R0001')).body.run.artifacts, []);

  // the second call: no id, the single active Run is closed, the successor is announced
  if (hasGit) {
    writeFileSync(join(gameDir, 'src', 'cast.gd'), 'extends Node\n');
    git(gameDir, 'add', '-A');
    git(gameDir, 'commit', '-q', '-m', 'B');
  }
  const commitB = hasGit ? git(gameDir, 'rev-parse', 'HEAD') : '';
  writeCheck('# Check\n[PASS] parse\n[PASS] test (3 tests)\nRESULT: PASS (3 tests)\n');
  result = ok(tt(['done', 'cast implemented, hook lands in the water'], { cwd: gameDir }));
  assert.deepEqual(result.lines, [
    'T-1 -> Done (run T-1-R0001, verified; evidence: last-check.md; auto-accepted)',
    'next: T-2 Task P1 Ready "Reel" - tt start T-2',
  ]);
  const closed = (await call(instance.url, '/api/tasks/T-1/packet')).body.task;
  assert.match(closed.Evidence, /RUN T-1-R0001 verified: cast implemented, hook lands in the water\nauto-accepted: RunEvidence \(T-1-R0001, artifact last-check\.md\)$/);
  if (hasGit) assert.deepEqual((await eventsOf('T-1', 'T-1-R0001')).filter((event) => event.type === 'GITREV').map((event) => event.message), [`base=${commitA}`, `head=${commitB} dirty=false`]);

  // T-2 with an explicit id and a hand-written summary; the PASS may come from --evidence
  ok(tt(['start', 'T-2'], { cwd: gameDir }));
  writeFileSync(join(gameDir, 'plans', 'ci-output.txt'), 'compile ok\nRESULT: PASS (reel)\n');
  if (hasGit) {
    writeFileSync(join(gameDir, 'src', 'reel.gd'), 'extends Node\n');
    git(gameDir, 'add', '-A');
    git(gameDir, 'commit', '-q', '-m', 'C');
  }
  const commitC = hasGit ? git(gameDir, 'rev-parse', 'HEAD') : '';
  writeFileSync(checkFile, 'stale and ignored: no longer newer than the Run\n');
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(checkFile, longAgo, longAgo);
  result = ok(tt(['done', 'T-2', 'reel works', '--evidence', 'plans/ci-output.txt'], { cwd: gameDir }));
  assert.equal(result.lines[0], 'T-2 -> Done (run T-2-R0001, verified; evidence: ci-output.txt; auto-accepted)');
  assert.match(result.lines[1], /^next: T-3 Task P1 Ready "Integration acceptance" - tt start T-3$/, 'the integration task is announced once the checks tasks are Done');

  // the integration task: three calls in total (start, done, review)
  ok(tt(['start'], { cwd: gameDir }));
  const longText = `${'行'.repeat(5_000)}\nEND\n`;
  writeFileSync(join(gameDir, 'plans', 'long.txt'), longText);
  assert.match(ok(tt(['art', 'T-3', 'long.txt', 'plans/long.txt'], { cwd: gameDir })).out, /^stored long\.txt on T-3-R0001/);
  if (hasGit) writeFileSync(join(gameDir, 'src', 'reel.gd'), 'extends Node\n# uncommitted tweak\n');
  writeCheck('RESULT: PASS (integration scenario)\n');
  result = ok(tt(['done', 'integration scenario passes'], { cwd: gameDir }));
  assert.deepEqual(result.lines, [
    'T-3 -> In Review (run T-3-R0001, verified; evidence: last-check.md)',
    'then: independent review (tt show S-1; tt review T-3 approve|reject|block "notes" --as NAME)',
  ]);
  assert.equal((await call(instance.url, '/api/tasks/T-3/packet')).body.task.Status, 'In Review', 'reviewer work is never auto-accepted');
  assert.equal((await call(instance.url, '/api/tasks/S-1/packet')).body.task.Status, 'Backlog', 'the Story is not Done before the integration review');

  // ---- tt show STORY: what the one reviewer reads ----------------------------------------------------------------------------------
  result = ok(tt(['show', 'S-1'], { cwd: gameDir }));
  assert.match(result.out, /^S-1 {2}Story {2}Backlog {2}P1 {2}\[NotApplicable\]$/m);
  assert.match(result.out, /^review: open - integration task T-3 is In Review; checks Done 2\/2$/m);
  assert.match(result.out, /^ {2}T-1 {2}Done {2}checks {2}T-1-R0001 {2}last-check\.md {2}auto-accepted$/m);
  assert.match(result.out, /^ {2}T-2 {2}Done {2}checks {2}T-2-R0001 {2}ci-output\.txt {2}auto-accepted$/m);
  assert.match(result.out, /^ {2}T-3 {2}In Review {2}reviewer {2}T-3-R0001 {2}last-check\.md,long\.txt$/m, 'reviewer work carries no auto-accepted flag');
  assert.match(result.out, /^inspect: tt evidence ID \[--name NAME\]; decide: tt review T-3 approve\|reject\|block "notes" --as NAME$/m);
  if (hasGit) {
    assert.match(result.out, new RegExp(`^diff range ${commitA.slice(0, 12)}\\.\\.${commitC.slice(0, 12)} {3}\\(the last tt done had uncommitted changes\\)$`, 'm'), 'earliest base .. latest head, with the dirty note');
  } else {
    assert.match(result.out, /^diff range: not recorded/m);
  }
  assert.ok(result.lines.length <= 25, 'the Story rollup stays short');
  const rollup = JSON.parse(ok(tt(['show', 'S-1', '--json'], { cwd: gameDir })).out).packet.context;
  assert.equal(rollup.review.state, 'open');
  assert.equal(rollup.children.length, 3);

  // ---- tt evidence ---------------------------------------------------------------------------------------------------------------------
  result = ok(tt(['evidence', 'T-1'], { cwd: gameDir }));
  assert.equal(result.lines[0], `evidence T-1 T-1-R0001 last-check.md (${Buffer.byteLength('# Check\n[PASS] parse\n[PASS] test (3 tests)\nRESULT: PASS (3 tests)\n')} bytes, the passing check)`);
  assert.match(result.out, /^RESULT: PASS \(3 tests\)$/m);
  assert.match(ok(tt(['evidence', 'T-2'], { cwd: gameDir })).out, /^evidence T-2 T-2-R0001 ci-output\.txt .*the passing check\)\ncompile ok\nRESULT: PASS \(reel\)$/m);
  result = tt(['evidence', 'T-1', '--name', 'nope.txt'], { cwd: gameDir });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-1-R0001 has no artifact 'nope\.txt' - it has: last-check\.md - try: tt evidence T-1 --name last-check\.md/);
  assert.match(tt(['evidence', 'T-1', '--run', 'T-1-R0009'], { cwd: gameDir }).err, /^tt: T-1 has no Run T-1-R0009 - its Runs: T-1-R0001/);
  assert.match(tt(['evidence', 'S-1'], { cwd: gameDir }).err, /^tt: S-1 is a Story - evidence belongs to the Runs of its tasks - try: tt show S-1 lists them/);
  assert.match(tt(['evidence', 'NOPE-1'], { cwd: gameDir }).err, /HTTP 404/);
  // long artifacts are cut at 8 KB with a pointer to the whole file; multi-byte text is not split in half
  result = ok(tt(['evidence', 'T-3', '--name', 'long.txt'], { cwd: gameDir }));
  assert.equal(result.lines[0], `evidence T-3 T-3-R0001 long.txt (${Buffer.byteLength(longText)} bytes)`);
  assert.ok(Buffer.byteLength(result.lines[1]) <= 8192 && !result.lines[1].includes(String.fromCharCode(0xFFFD)), 'the cut respects character boundaries');
  const truncation = /^\.\.\. truncated: showing (\d+) of (\d+) bytes; the whole file: (.*)$/.exec(result.lines[2]);
  assert.ok(truncation, result.lines[2]);
  assert.equal(Number(truncation[2]), Buffer.byteLength(longText));
  assert.ok(Number(truncation[1]) <= 8192);
  assert.match(truncation[3], /task-records.T-3.T-3-R0001.artifacts.long\.txt$/);
  assert.equal(readFileSync(truncation[3], 'utf8'), longText, 'the printed path really holds the whole artifact');
  assert.equal(result.lines[3], 'artifacts of T-3-R0001: last-check.md, long.txt (tt evidence T-3 --name NAME)');

  // ---- the one independent review ----------------------------------------------------------------------------------------------------------
  assert.match(tt(['review', 'T-3', 'approve', 'looks fine', '--as', 'Claude'], { cwd: gameDir }).err, /is not independent of 'claude'/);
  assert.match(tt(['review', 'T-1', 'approve', 'x', '--as', 'someone'], { cwd: gameDir }).err, /^tt: T-1 is Done, not In Review/, 'checks tasks have no review');
  result = ok(tt(['review', 'T-3', 'approve', 'read the Story rollup and the evidence; the scenario covers cast to reel', '--as', 'story-reviewer'], { cwd: gameDir }));
  assert.equal(result.lines[0], 'T-3 -> Done (approved by story-reviewer)');
  assert.equal((await call(instance.url, '/api/tasks/S-1/packet')).body.task.Status, 'Done', 'the Story is Done after the integration review');
  assert.match(ok(tt(['show', 'S-1'], { cwd: gameDir })).out, /^review: complete \(T-3 is Done\)$/m);
  assert.equal(ok(tt(['next'], { cwd: gameDir })).out.trim(), 'none: All 3 executable task(s) are Done.');

  // ---- tt new warns, tt doctor lists, the fix removes both -----------------------------------------------------------------------------------
  assert.equal(ok(tt(['new', 'S-2', 'Second story', '--type', 'Story', '--accept', 'second slice works'], { cwd: gameDir })).out.trim(), 'created S-2 (Story, Backlog)');
  result = ok(tt(['new', 'U-1', 'Unit work', '--parent', 'S-2', '--auth', 'checks', '--accept', 'unit tests pass'], { cwd: gameDir }));
  assert.equal(result.lines[0], 'created U-1 (Task, Backlog)');
  assert.match(result.lines[1], /^warning: Story S-2 has checks Tasks \(U-1\) but no reviewer Task yet; add the integration-acceptance Task: tt new ID "integration acceptance" --parent S-2 --deps "U-1" --auth reviewer --accept "\.\.\."$/);
  result = ok(tt(['doctor'], { cwd: gameDir }));
  assert.match(result.out, /^warn Story S-2 has checks Tasks \(U-1\) but no reviewer Task yet/m, 'doctor lists the violation');
  assert.match(tt(['new', 'U-9', 'x', '--accept', 'y', '--auth', 'robot'], { cwd: gameDir }).err, /^tt: --auth robot is not valid - use reviewer \(independent review\), checks \(done when the project check passes\) or owner \(human decision\)/);
  result = ok(tt(['new', 'U-2', 'Integration', '--parent', 'S-2', '--deps', 'U-1', '--auth', 'reviewer', '--accept', 'the slice works end to end'], { cwd: gameDir }));
  assert.deepEqual(result.lines, ['created U-2 (Task, Backlog)'], 'the covering reviewer Task silences the warning');
  result = ok(tt(['doctor'], { cwd: gameDir }));
  assert.doesNotMatch(result.out, /^warn/m);
  assert.match(result.out, /^ok {3}no problems found$/m);
  const created = JSON.parse(ok(tt(['ls', '--parent', 'S-2', '--json'], { cwd: gameDir })).out).tasks;
  assert.deepEqual(created.map((task) => [task.taskId, task.completionAuthority]), [['U-1', 'RunEvidence'], ['U-2', 'IndependentReviewerAgent']]);

  // ---- tt done: id or summary, failure modes, a second Story without git --------------------------------------------------------------------------
  assert.match(tt(['done', 'NOPE-9', 'summary'], { cwd: gameDir }).err, /^tt: no task 'NOPE-9' - tt done takes an optional task id first; this looks like one, but the Hub does not know it - try: tt ls/);
  assert.match(tt(['done', 'just some words'], { cwd: gameDir }).err, /^tt: there is no active Run to close - no task is In Progress - try: tt next, then tt start; or name the task: tt done ID "summary"/);
  const plainDir = mkdtempSync(join(parent, 'plain '));
  mkdirSync(join(plainDir, 'reports'), { recursive: true });
  ok(tt(['admit', 'U-1'], { cwd: plainDir }));
  result = ok(tt(['start', 'U-1'], { cwd: plainDir }));
  assert.equal(result.lines[0], 'started U-1: run U-1-R0001, profile logic, agent claude');
  assert.deepEqual((await eventsOf('U-1', 'U-1-R0001')).filter((event) => event.type === 'GITREV'), [], 'outside a git repository nothing is recorded and nothing fails');
  const plainCheck = join(plainDir, 'reports', 'last-check.md');
  writeFileSync(plainCheck, 'RESULT: PASS (no git here)\n');
  stamp(plainCheck);
  assert.equal(ok(tt(['done'], { cwd: plainDir })).lines[0], 'U-1 -> Done (run U-1-R0001, verified; evidence: last-check.md; auto-accepted)', 'tt done needs no argument at all');
  assert.match(ok(tt(['show', 'S-2'], { cwd: plainDir })).out, /^diff range: not recorded/m);

  // ---- several tasks In Progress (open lane): the Run is chosen by agent ---------------------------------------------------------------------------------
  const open = await createInstance({ parent, name: 'Tracker open ', projectId: 'tt-story-open', projectName: 'Open Lane' });
  instances.push(open);
  const configPath = join(open.root, 'task-hub.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.workflow.serialLane = false;
  writeFileSync(configPath, JSON.stringify(config));
  const ttOpen = ttFor(open);
  for (const id of ['A-1', 'A-2', 'A-3']) ok(ttOpen(['new', id, `task ${id}`, '--accept', 'works', '--auth', 'checks'], { cwd: plainDir }));
  for (const [id, agent] of [['A-1', 'agent-a'], ['A-2', 'agent-b'], ['A-3', 'agent-a']]) {
    ok(ttOpen(['admit', id], { cwd: plainDir, env: { TT_AGENT: agent } }));
    ok(ttOpen(['start', id], { cwd: plainDir, env: { TT_AGENT: agent } }));
  }
  result = ttOpen(['done', 'all good', '--no-evidence'], { cwd: plainDir, env: { TT_AGENT: 'agent-a' } });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: 2 of your tasks are In Progress - active: A-1 \(agent agent-a\), A-2 \(agent agent-b\), A-3 \(agent agent-a\) - try: tt done ID "summary"/);
  result = ttOpen(['done', 'all good', '--no-evidence'], { cwd: plainDir, env: { TT_AGENT: 'agent-c' } });
  assert.match(result.err, /^tt: no active Run belongs to agent 'agent-c' - active: A-1/);
  writeFileSync(plainCheck, 'RESULT: PASS (a2)\n');
  stamp(plainCheck);
  result = ok(ttOpen(['done', 'agent-b is done'], { cwd: plainDir, env: { TT_AGENT: 'agent-b' } }));
  assert.match(result.lines[0], /^A-2 -> Done \(run A-2-R0001, verified; evidence: last-check\.md; auto-accepted\)$/, 'the one active Run of this agent is closed');
  assert.match(ttOpen(['done', 'x', '--no-evidence'], { cwd: plainDir, env: { TT_AGENT: 'agent-b' } }).err, /no active Run belongs to agent 'agent-b'/);
  ok(ttOpen(['done', 'A-3', 'closes by id regardless of agent', '--evidence', 'reports/last-check.md'], { cwd: plainDir, env: { TT_AGENT: 'agent-c' } }));
  // a single active Run of somebody else is not closed implicitly
  assert.match(ttOpen(['done', 'x', '--no-evidence'], { cwd: plainDir, env: { TT_AGENT: 'agent-c' } }).err, /^tt: A-1 is claimed by agent-a, not by agent-c - tt done without an id only closes your own Run - try: tt done A-1 "summary" \(TT_AGENT names you\)/);

  console.log('tt-story test passed: import invariant, checks in two calls, evidence pre-check, GITREV, story rollup, evidence, single review, warnings and doctor.');
}, async () => {
  for (const hub of hubs) { try { await hub.stop(); } catch { /* gone */ } }
  for (const instance of instances) await instance.dispose();
  for (const sandbox of sandboxes) await sandbox.dispose();
});
