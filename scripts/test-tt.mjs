#!/usr/bin/env node
// tt end to end: a real Tracker instance in a folder whose path has a space and
// Chinese characters, a separate game folder with the task file, and tt run as an
// agent would run it (separate processes, auto-started detached server).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, createInstance, mutation, runSuite, sleep, waitFor } from './lib/test-support.mjs';

const parent = join(tmpdir(), 'Hub 测试 空格');
mkdirSync(parent, { recursive: true });
const instance = await createInstance({ parent, name: 'Tracker 钓鱼 ', projectId: 'tt-e2e', projectName: '钓鱼 Fishing' });
const gameDir = mkdtempSync(join(parent, 'game 游戏 '));
mkdirSync(join(gameDir, 'docs', 'tasks'), { recursive: true });
mkdirSync(join(gameDir, 'reports'), { recursive: true });
const ttPath = join(instance.root, '.agents', 'skills', 'game-task-hub', 'scripts', 'tt.mjs');
const junctions = [];
const cleanEnv = { ...process.env };
for (const name of ['TT_URL', 'TT_DIR', 'TT_AGENT', 'TT_REVIEWER']) delete cleanEnv[name];

function tt(args, { cwd = gameDir, env = {}, input, script = ttPath } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv, ...env }, input });
  return { status: result.status, out: result.stdout, err: result.stderr, lines: result.stdout.split('\n').filter(Boolean) };
}
const ok = (result) => { assert.equal(result.status, 0, `exit ${result.status}: ${result.err}${result.out}`); return result; };

const taskFile = `# Tasks: M1 原型
Milestone: M1
Stream: 玩法
Lane: slice

## S-FISH: 抛竿与收线原型
- Acceptance: 玩家按下抛竿键后鱼钩落水，
  按住收线键时浮标向岸边移动。

### T-001: 抛竿动作与鱼钩落点
- Depends: -
- Acceptance: 按下 Space 后鱼钩沿抛物线飞出，落点出现水花。
- Profile: runtime

### T-002: 收线与上钩提示
- Depends: T-001
- Acceptance: 按住 Space 浮标向岸边移动，鱼上钩时出现感叹号。
`;
writeFileSync(join(gameDir, 'docs', 'tasks', 'm1.md'), taskFile);

await runSuite('tt', async () => {
  // ---- help, version, unknown input need no server ----------------------------------------------
  let result = ok(tt(['help']));
  assert.ok(result.lines.length <= 14 && result.out.includes('import FILE') && result.out.includes('review ID approve|reject|block'), 'help is a short command list');
  result = tt(['bogus']);
  assert.equal(result.status, 1);
  assert.equal(result.err.trim(), "tt: unknown command 'bogus' - not a tt command - try: tt help");
  result = tt(['ls', '--nope']);
  assert.match(result.err, /^tt: unknown option --nope - not a tt option - try: tt help/);
  result = tt(['url']);
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: the server is not running - there is no URL to print - try: tt up/);

  // ---- up / url / discovery ------------------------------------------------------------------------
  result = ok(tt(['up']));
  assert.equal(result.out.trim(), instance.url);
  assert.equal(await instance.readTrackerFile('.tracker-url'), instance.url);
  assert.equal(ok(tt(['up'])).out.trim(), instance.url, 'a second up is a no-op');
  assert.equal(ok(tt(['url'])).out.trim(), instance.url);
  const health = (await call(instance.url, '/api/health')).body;
  assert.equal(ok(tt(['--version'])).out.trim(), `tt ${health.toolVersion}`, 'tt and server versions agree');
  assert.equal(JSON.parse(ok(tt(['up', '--json'])).out).projectId, 'tt-e2e');
  // the stub in the instance root works as well
  assert.equal(ok(tt(['url'], { script: join(instance.root, 'scripts', 'tt.mjs') })).out.trim(), instance.url);
  // explicit overrides
  assert.equal(ok(tt(['url'], { cwd: parent, env: { TT_DIR: instance.root } })).out.trim(), instance.url);
  assert.equal(ok(tt(['ls'], { env: { TT_URL: instance.url.replace('127.0.0.1', 'localhost') } })).out.trim(), '(no tasks match)');
  result = tt(['ls'], { env: { TT_URL: 'http://127.0.0.1:1' } });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: the server at TT_URL \(http:\/\/127\.0\.0\.1:1\) does not answer/);

  // ---- import: dry run, errors write nothing, real import, idempotence ------------------------------
  result = ok(tt(['import', 'docs/tasks/m1.md', '--dry-run']));
  assert.equal(result.lines[0], 'dry-run docs/tasks/m1.md: would create 3 (1 Story, 2 Task, 0 Bug), skip 0 existing');
  assert.equal(ok(tt(['ls'])).out.trim(), '(no tasks match)', 'dry run writes nothing');

  const badFiles = {
    'unknown-dep.md': ['Milestone: M1', '### T-1: x', '- Depends: T-404', '- Acceptance: y'],
    'cycle.md': ['Milestone: M1', '### T-1: a', '- Depends: T-2', '- Acceptance: y', '### T-2: b', '- Depends: T-1', '- Acceptance: y'],
    'prototype.md': ['Milestone: M0', 'Lane: prototype', '## S-P: p', '- Acceptance: y'],
    'no-acceptance.md': ['Milestone: M1', '### T-1: x'],
    'no-milestone.md': ['### T-1: x', '- Acceptance: y'],
  };
  for (const [name, lines] of Object.entries(badFiles)) writeFileSync(join(gameDir, 'docs', 'tasks', name), `${lines.join('\n')}\n`);
  result = tt(['import', 'docs/tasks/unknown-dep.md']);
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: import docs\/tasks\/unknown-dep\.md - 1 problem\(s\), nothing was written - try: fix the file and run tt import again/);
  assert.match(result.err, /line 2: T-1: depends on T-404, which is neither in this file nor in the Hub/);
  assert.match(tt(['import', 'docs/tasks/cycle.md']).err, /dependency cycle among T-1, T-2/);
  result = tt(['import', 'docs/tasks/prototype.md']);
  assert.equal(result.status, 1);
  assert.match(result.err, /is a prototype-lane task set - Lane is 'prototype'.*not tracked in the Hub/);
  assert.match(tt(['import', 'docs/tasks/no-acceptance.md']).err, /Acceptance is required/);
  assert.match(tt(['import', 'docs/tasks/no-milestone.md']).err, /Milestone is required in the header/);
  assert.equal(ok(tt(['import', 'docs/tasks/no-milestone.md', '--milestone', 'M3', '--dry-run'])).lines[0].includes('would create 1'), true, '--milestone supplies a missing header');
  assert.match(tt(['import', 'docs/tasks/missing.md']).err, /^tt: cannot read docs\/tasks\/missing\.md - no such file/);
  assert.equal(ok(tt(['ls'])).out.trim(), '(no tasks match)', 'no failed import may write anything');

  result = ok(tt(['import', 'docs/tasks/m1.md', '--admit-first']));
  assert.deepEqual(result.lines, [
    'imported docs/tasks/m1.md: created 3 (1 Story, 2 Task, 0 Bug), skipped 0 existing',
    'created: S-FISH T-001 T-002',
    'admitted: T-001 (Ready) - tt start T-001',
  ]);
  const csv = await readFile(instance.trackerPath, 'utf8');
  assert.ok(csv.includes('抛竿动作与鱼钩落点') && csv.includes('docs/tasks/m1.md#t-001'), 'Chinese titles and the SpecRef reach the CSV intact');
  assert.ok(!csv.includes('\r'));
  result = ok(tt(['import', 'docs/tasks/m1.md']));
  assert.match(result.lines[0], /^nothing to import from docs\/tasks\/m1\.md: all 3 item\(s\) already exist/);
  result = ok(tt(['ls']));
  assert.deepEqual(result.lines, ['S-FISH\tStory\tBacklog\t-\t抛竿与收线原型', 'T-001\tTask\tReady\t-\t抛竿动作与鱼钩落点', 'T-002\tTask\tBacklog\tT-001\t收线与上钩提示']);
  assert.deepEqual(ok(tt(['ls', '--status', 'Ready'])).lines, ['T-001\tTask\tReady\t-\t抛竿动作与鱼钩落点']);
  assert.deepEqual(ok(tt(['ls', '--parent', 'S-FISH', '--type', 'Task', '--limit', '1'])).lines.length, 2, 'limit adds a "... more" line');

  // ---- next / show -----------------------------------------------------------------------------------
  result = ok(tt(['next']));
  assert.equal(result.lines[0], 'T-001\tTask\tP1\tReady\t抛竿动作与鱼钩落点');
  assert.match(result.out, /^acceptance: 按下 Space 后鱼钩沿抛物线飞出，落点出现水花。$/m);
  assert.match(result.out, /^spec: docs\/tasks\/m1\.md#t-001$/m);
  assert.match(result.out, /^then: tt start T-001$/m);
  result = ok(tt(['show', 'T-002']));
  assert.ok(result.lines.length <= 40);
  assert.match(result.out, /^deps: T-001=Ready$/m);
  assert.match(result.out, /^story: S-FISH 抛竿与收线原型 \| 玩家按下抛竿键后鱼钩落水，按住收线键时浮标向岸边移动。$/m);
  assert.match(tt(['show', 'NOPE-1']).err, /^tt: show NOPE-1 failed - HTTP 404: Task 'NOPE-1' was not found\. - try: tt ls/);

  // ---- start (admit-if-needed, idempotent, defaults), event, art ----------------------------------------
  assert.match(tt(['start']).err, /^tt: start needs ID/);
  result = ok(tt(['start', 'T-001', '--profile', 'runtime']));
  assert.equal(result.out.trim(), 'started T-001: run T-001-R0001, profile runtime, agent claude');
  assert.equal(ok(tt(['start', 'T-001'])).out.trim(), 'T-001 already in progress: run T-001-R0001 (agent claude)', 'start is idempotent for the same agent');
  result = tt(['start', 'T-001'], { env: { TT_AGENT: 'someone-else' } });
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-001 is already claimed by claude - run T-001-R0001 is active - try: tt show T-001/);
  const run = (await call(instance.url, '/api/tasks/T-001/runs/T-001-R0001')).body.run;
  assert.equal(run.verificationProfile, 'runtime');
  assert.equal(run.scope, '抛竿动作与鱼钩落点', 'scope defaults to the title');
  assert.equal(run.expectedBehavior, '按下 Space 后鱼钩沿抛物线飞出，落点出现水花。', 'expected behaviour defaults to the acceptance');
  assert.match(tt(['start', 'T-002']).err, /Only Ready tasks can start a managed Run\. T-002 is 'Blocked'\. - try: tt unblock T-002/, 'the armed successor is Blocked until T-001 is Done');

  ok(tt(['event', 'T-001', 'note', 'ok', '抛物线实现完成，水花待确认']));
  ok(tt(['event', 'T-001', 'T-001-R0001', 'check', 'pass', 'explicit run id form']));
  assert.match(tt(['event', 'T-001', 'note']).err, /^tt: event needs ID TYPE RESULT "message"/);
  const events = (await call(instance.url, '/api/tasks/T-001/runs/T-001-R0001')).body.events;
  assert.deepEqual(events.filter((event) => event.type !== 'claim').map((event) => [event.type, event.result, event.message]), [['note', 'ok', '抛物线实现完成，水花待确认'], ['check', 'pass', 'explicit run id form']]);

  writeFileSync(join(gameDir, 'notes.md'), '# 证据\n- 场景运行 100 帧无错误\n');
  result = ok(tt(['art', 'T-001', 'notes.md', 'notes.md']));
  assert.match(result.out.trim(), /^stored notes\.md on T-001-R0001 \(\d+ bytes\)$/);
  result = ok(tt(['art', 'T-001', 'stdin-note.txt', '-'], { input: '来自标准输入的证据\n' }));
  assert.match(result.out, /^stored stdin-note\.txt/);
  assert.match(tt(['art', 'T-001', 'notes.md', 'notes.md']).out, /stored notes\.md/, 'identical re-upload is accepted (idempotent)');
  writeFileSync(join(gameDir, 'notes.md'), 'changed content\n');
  assert.match(ok(tt(['art', 'T-001', 'notes.md', 'notes.md'])).out, /stored notes-2\.md/, 'different content under the same name gets a new name');
  writeFileSync(join(gameDir, 'big.txt'), 'x'.repeat(131_073));
  assert.match(tt(['art', 'T-001', 'big.txt', 'big.txt']).err, /^tt: big\.txt is 131073 bytes - an artifact is limited to 131072 bytes \(128 KB\)/);
  writeFileSync(join(gameDir, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x03]));
  assert.match(tt(['art', 'T-001', 'blob.bin', 'blob.bin']).err, /is not a text file/);
  assert.match(tt(['art', 'T-001', 'bad name.md', 'notes.md']).err, /artifact name 'bad name\.md' is not valid/);
  assert.match(tt(['art', 'T-001', 'x.md', 'missing-file.md']).err, /^tt: cannot read missing-file\.md - no such file/);

  // ---- done: evidence rules ---------------------------------------------------------------------------------
  result = tt(['done', 'T-001', '收线完成']);
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: T-001 cannot be closed as verified without evidence - no --evidence file and no reports\/last-check\.md - try: run the project check/);
  // a check that predates the Run does not count
  const checkFile = join(gameDir, 'reports', 'last-check.md');
  writeFileSync(checkFile, '# old check\n');
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(checkFile, longAgo, longAgo);
  assert.match(tt(['done', 'T-001', '完成']).err, /reports\/last-check\.md is older than this Run - run the check again/);
  writeFileSync(join(gameDir, 'evidence-cast.md'), '# 证据\n- 抛竿手感通过\n');
  result = ok(tt(['done', 'T-001', '抛竿与落点完成并验证', '--evidence', 'evidence-cast.md']));
  assert.equal(result.out.trim(), 'T-001 -> In Review (run T-001-R0001, verified; evidence: evidence-cast.md)');
  assert.deepEqual((await call(instance.url, '/api/tasks/T-001/runs/T-001-R0001')).body.run.artifacts.map((artifact) => artifact.name).sort(), ['evidence-cast.md', 'notes-2.md', 'notes.md', 'stdin-note.txt']);
  assert.match(tt(['done', 'T-001', 'again']).err, /^tt: T-001 is In Review, not In Progress - only a task with an active Run can be closed - try: tt show T-001/);
  assert.match(ok(tt(['next'])).out, /^none: T-001 is In Review \(implemented by claude\): a different reviewer decides with: tt review T-001 approve\|reject\|block "notes"/);

  // ---- review: independence, claim+decide in one step, successor ----------------------------------------------
  assert.match(tt(['review', 'T-001', 'approve']).err, /^tt: review notes are required/);
  assert.match(tt(['review', 'T-001', 'maybe', 'notes']).err, /^tt: 'maybe' is not a review decision/);
  result = tt(['review', 'T-001', 'approve', '看起来没问题', '--as', '  CLAUDE ']);
  assert.equal(result.status, 1);
  assert.match(result.err, /^tt: reviewer 'CLAUDE' is not independent of 'claude' - a reviewer must differ from every agent that implemented the task/);
  result = tt(['review', 'T-001', 'approve', '看起来没问题'], { env: { TT_AGENT: 'unused', TT_REVIEWER: 'Claude' } });
  assert.equal(result.status, 1, 'TT_REVIEWER is checked like --as');
  result = ok(tt(['review', 'T-001', 'approve', '核对了验收条件：抛物线与水花均符合']));
  assert.match(result.lines[0], /^T-001 -> Done \(approved by reviewer-[0-9a-f]{4}\)$/);
  assert.match(result.lines[1], /^next: T-002 Task P1 Ready "收线与上钩提示" - tt start T-002$/, 'approval shows the armed successor');
  const reviewed = (await call(instance.url, '/api/tasks/T-001/packet')).body.task;
  assert.match(reviewed.Reviewer, /^reviewer-[0-9a-f]{4} \/ approved \//);
  assert.match(reviewed.Evidence, /REVIEW approved: reviewer-[0-9a-f]{4} .*; 核对了验收条件：抛物线与水花均符合/);

  // ---- second task: auto-attached reports/last-check.md, fixed reviewer name, --json ------------------------------------
  ok(tt(['start', 'T-002']));
  await sleep(1_100);
  writeFileSync(checkFile, '# Check\n[PASS] parse\n[PASS] test (3 tests)\n');
  result = ok(tt(['done', 'T-002']));
  assert.equal(result.out.trim(), 'T-002 -> In Review (run T-002-R0001, verified; evidence: last-check.md)', 'a fresh reports/last-check.md is attached automatically; summary has a default');
  const doneJson = JSON.parse(ok(tt(['review', 'T-002', 'approve', '检查通过', '--as', 'fixed-reviewer', '--json'])).out);
  assert.deepEqual([doneJson.status, doneJson.reviewer, doneJson.decision], ['Done', 'fixed-reviewer', 'approved']);
  assert.equal(doneJson.next, null);
  assert.equal(ok(tt(['next'])).out.trim(), 'none: All 2 executable task(s) are Done.');
  assert.equal((await call(instance.url, '/api/tasks/S-FISH/packet')).body.task.Status, 'Done', 'the Story is Done when its Tasks are');

  // ---- new / DecisionOwner flow / other transitions --------------------------------------------------------------------------
  assert.match(tt(['new', 'T-003', 'no acceptance']).err, /^tt: --accept is required/);
  assert.match(tt(['new', 'T-003', 'x', '--accept', 'y', '--type', 'Epic']).err, /--type Epic is not valid/);
  assert.match(tt(['new', 'T-003', 'x', '--accept', 'y', '--deps', 'T-404']).err, /Unknown dependency TaskID\(s\): T-404\./);
  assert.equal(ok(tt(['new', 'T-003', '鱼线张力', '--accept', '拉力超限时鱼线断裂', '--parent', 'S-FISH', '--deps', 'T-001, T-002'])).out.trim(), 'created T-003 (Task, Backlog)');
  const created = (await call(instance.url, '/api/tasks/T-003/packet')).body.task;
  assert.deepEqual([created.DependsOn, created.ParentID, created.Milestone, created.Workstream, created.Priority], ['T-001;T-002', 'S-FISH', 'M1', '玩法', 'P1'], 'comma-separated deps are normalized; milestone and stream come from the parent');
  assert.equal(ok(tt(['new', 'D-001', '玩感拍板', '--accept', '负责人确认手感', '--auth', 'owner', '--prio', 'P0', '--milestone', 'M2'])).out.trim(), 'created D-001 (Task, Backlog)');
  assert.equal(ok(tt(['new', 'BUG-1', '偶发崩溃', '--type', 'Bug', '--accept', '不再崩溃', '--spec', 'docs/bugs.md#bug-1'])).out.trim(), 'created BUG-1 (Bug, Backlog)');
  assert.equal(ok(tt(['admit', 'T-003'])).out.trim(), 'T-003 -> Ready');
  assert.match(tt(['admit', 'BUG-1']).err, /Serial lane is occupied by T-003 \(Ready\)/);
  assert.match(tt(['admit', 'BUG-1']).err, /try: tt show T-003/);
  assert.equal(ok(tt(['block', 'T-003', '缺少鱼线美术资源'])).out.trim(), 'T-003 -> Blocked (缺少鱼线美术资源)');
  assert.equal(ok(tt(['unblock', 'T-003'])).out.trim(), 'T-003 -> Ready');
  ok(tt(['start', 'T-003']));
  assert.match(tt(['done', 'T-003', '--outcome', 'blocked']).err, /^tt: a blocked Run needs --blocker/);
  assert.match(tt(['done', 'T-003', '--outcome', 'awaiting-human']).err, /awaiting-human needs a summary/);
  assert.match(tt(['done', 'T-003', '--outcome', 'nope', 's']).err, /--outcome nope is not valid/);
  result = ok(tt(['done', 'T-003', '--outcome', 'blocked', '--blocker', '等待美术资源']));
  assert.equal(result.out.trim(), 'T-003 -> Blocked (run T-003-R0001, blocked)');
  assert.equal(ok(tt(['park', 'T-003'])).out.trim(), 'T-003 -> Backlog');
  assert.equal(ok(tt(['status', '--brief'])).out.trim().includes('Done 2'), true);

  // a DecisionOwner task closes as awaiting-human by default
  assert.equal(ok(tt(['admit', 'D-001'])).out.trim(), 'D-001 -> Ready');
  ok(tt(['start', 'D-001']));
  result = ok(tt(['done', 'D-001', '请确认抛竿手感是否合格']));
  assert.equal(result.out.trim(), 'D-001 -> Awaiting Owner (run D-001-R0001, awaiting-human)');
  assert.match(ok(tt(['status'])).out, /^owner: D-001 Awaiting Owner$/m);

  // toolchain issue report
  result = ok(tt(['issue', 'T-001', 'Godot import timed out after 120 s', '--key', 'godot.headless.import-timeout', '--toolchain', 'godot', '--op', 'import', '--detail', '第二次出现']));
  assert.equal(result.out.trim(), 'reported godot.headless.import-timeout: 1 report(s), 1 unacknowledged');
  assert.match(tt(['issue', 'T-001', 'x']).err, /--key is required/);

  // ---- status / doctor ---------------------------------------------------------------------------------------------------------
  result = ok(tt(['status']));
  assert.match(result.lines[0], /^钓鱼 Fishing \(tt-e2e\)  http:\/\/127\.0\.0\.1:\d+  rev [0-9a-f]{8}  lane serial$/);
  assert.match(result.out, /^next: none - /m);
  result = ok(tt(['doctor']));
  assert.match(result.out, /^ok {3}server .* v\d+\.\d+\.\d+ pid \d+$/m);
  assert.match(result.out, /^ok {3}no problems found$/m);

  // ---- owner feedback -> tt eval (the owner answers in the dashboard; here through the same endpoint) -------------
  const ownerFeedback = async (taskId, text) => {
    const revision = (await call(instance.url, '/api/health')).body.trackerRevision;
    const answered = await call(instance.url, '/api/feedback', mutation(instance.url, { trackerRevision: revision, taskId, feedback: text }));
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  };
  assert.match(tt(['eval', 'D-001', 'approve', '还没有反馈']).err, /^tt: D-001 is Awaiting Owner, not Awaiting Agent Evaluation - there is no owner feedback waiting for an agent - try: wait for the owner to answer in the dashboard/);
  await ownerFeedback('D-001', '手感可以，通过');
  assert.match(ok(tt(['show', 'D-001'])).out, /\[OWNER FEEDBACK [^\]]+\] 手感可以，通过/, 'tt show surfaces the owner feedback');
  assert.match(tt(['eval', 'D-001', 'resume', '继续']).err, /^tt: 'resume' does not fit a DecisionOwner task - use approve, block, defer or return/);
  assert.match(tt(['eval', 'D-001', 'approve']).err, /^tt: eval needs ID approve\|resume\|block\|defer\|return "notes"/);
  assert.equal(ok(tt(['eval', 'D-001', 'approve', '负责人试玩后确认手感通过'])).out.trim(), 'D-001 -> Done (approve)');
  assert.match((await call(instance.url, '/api/tasks/D-001/packet')).body.task.Evidence, /OWNER EVALUATION approved: claude .*; 负责人试玩后确认手感通过/);

  // reviewer-authority work cannot be approved by feedback; it resumes with a new Run and review
  ok(tt(['new', 'E-001', '手感调参', '--accept', '参数在试玩中可接受']));
  ok(tt(['start', 'E-001']));
  ok(tt(['done', 'E-001', '需要负责人试玩确认参数', '--outcome', 'awaiting-human', '--owner-status', 'Awaiting Owner Gate']));
  assert.match(ok(tt(['ls', '--status', 'Awaiting Owner Gate'])).out, /^E-001\tTask\tAwaiting Owner Gate/);
  await ownerFeedback('E-001', '再快一点');
  assert.match(tt(['eval', 'E-001', 'approve', 'x']).err, /does not fit IndependentReviewerAgent work - feedback cannot approve it: resume \(new Run \+ independent review\), block or return/);
  assert.equal(ok(tt(['eval', 'E-001', 'resume', '把收线速度提高 20%'])).out.trim(), 'E-001 -> Ready (resume)');
  ok(tt(['start', 'E-001']));
  ok(tt(['done', 'E-001', '收线速度已提高 20% 并验证', '--no-evidence']));
  ok(tt(['review', 'E-001', 'approve', '参数符合反馈', '--as', 'eval-reviewer']));
  assert.match(ok(tt(['ls', '--status', 'Done'])).out, /E-001\tTask\tDone/);

  // ---- resilience: parallel writers all succeed (stale revision / lock retries) ---------------------------------
  ok(tt(['new', 'P-001', '并发写入', '--accept', '六个并发事件都被记录']));
  ok(tt(['start', 'P-001']));
  const parallel = await Promise.all(Array.from({ length: 6 }, (_, index) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [ttPath, 'event', 'P-001', 'note', 'ok', `parallel writer ${index}`], { cwd: gameDir, env: cleanEnv });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolveRun({ code, stderr }));
  })));
  assert.deepEqual(parallel.map((outcome) => outcome.code), [0, 0, 0, 0, 0, 0], parallel.map((outcome) => outcome.stderr).join('|'));
  const parallelEvents = (await call(instance.url, '/api/tasks/P-001/runs/P-001-R0001')).body.events.filter((event) => event.type === 'note');
  assert.equal(parallelEvents.length, 6, 'every parallel event is recorded exactly once');
  ok(tt(['done', 'P-001', '--no-evidence']));
  ok(tt(['review', 'P-001', 'approve', '并发事件已核对', '--as', 'parallel-reviewer']));

  // ---- a killed server leaves a stale lock and stale files: tt just works again -----------------------------------
  const pidBefore = Number(await instance.readTrackerFile('.tracker-pid'));
  process.kill(pidBefore);
  await waitFor(async () => !(await fetch(`${instance.url}/api/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)), { message: 'the killed server to go away' });
  writeFileSync(`${instance.trackerPath}.lock`, JSON.stringify({ pid: pidBefore, host: hostname(), createdAt: new Date().toISOString(), token: 'dead' }));
  assert.match(ok(tt(['doctor'])).out, /^warn lock task_tracker\.csv\.lock held \d+s by pid \d+;/m, 'doctor reports the leftover lock');
  result = ok(tt(['new', 'R-001', '崩溃后恢复', '--accept', '服务被强杀后命令仍能写入']));
  assert.equal(result.out.trim(), 'created R-001 (Task, Backlog)');
  const pidAfter = Number(await instance.readTrackerFile('.tracker-pid'));
  assert.notEqual(pidAfter, pidBefore, 'a new server was started automatically');

  // ---- down, then auto-start again -----------------------------------------------------------------------------------
  assert.equal(ok(tt(['down'])).out.trim(), `stopped (pid ${pidAfter})`);
  assert.equal(ok(tt(['down'])).out.trim(), 'not running');
  assert.match(ok(tt(['ls', '--status', 'Backlog'])).out, /R-001/, 'any command starts the server again');

  // ---- through a directory junction, exactly how a game project reaches the skill -------------------------------------------
  const linked = spawnSync(process.execPath, [join(instance.root, 'scripts', 'link-game-skill.mjs'), gameDir], { encoding: 'utf8' });
  assert.equal(linked.status, 0, linked.stderr);
  junctions.push(join(gameDir, '.claude', 'skills', 'game-task-hub'));
  const viaJunction = join(gameDir, '.claude', 'skills', 'game-task-hub', 'scripts', 'tt.mjs');
  assert.match(ok(tt(['ls', '--status', 'Done'], { script: viaJunction })).out, /T-001	Task	Done/, 'tt resolves the tracker instance through the junction');

  console.log('tt test passed: import (Chinese, errors write nothing, idempotent), start/event/art/done/review flow, evidence rules, independence, retries under parallel writers, stale lock and server restart, junction.');
}, async () => {
  for (const link of junctions) {
    try { if (process.platform === 'win32') rmdirSync(link); else unlinkSync(link); } catch { /* not created */ }
  }
  await instance.dispose();
  rmSync(gameDir, { recursive: true, force: true });
});
