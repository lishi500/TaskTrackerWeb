#!/usr/bin/env node
// CompletionAuthority RunEvidence ("checks"): a verified close with a passing check artifact goes
// straight to Done (never In Review); FAIL markers and missing evidence are refused with 422; the
// serial lane advances as after an approval; a Story is not Done until its integration Task passed
// independent review ("review once per Story"). Old CSVs and old configs keep working.

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, createInstance, createSandbox, mutation, repoRoot, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const hubs = [];
const sandboxes = [];
const BOM = String.fromCharCode(0xFEFF);

async function newHub(rows, env = {}) {
  const sandbox = await createSandbox('task-tracker-evidence-', rows);
  sandboxes.push(sandbox);
  const hub = await startHub({ trackerPath: sandbox.trackerPath, env: { TASK_HUB_SERIAL_LANE: 'true', ...env } });
  hubs.push(hub);
  return { sandbox, hub, url: hub.url };
}

const revisionOf = async (url) => (await call(url, '/api/dependency-audit')).body.revision;
const post = async (url, path, payload) => call(url, path, mutation(url, { trackerRevision: await revisionOf(url), ...payload }));
const story = (id, extra = {}) => taskRow({ TaskID: id, TaskType: 'Story', CompletionAuthority: 'NotApplicable', ...extra });
const checks = (id, extra = {}) => taskRow({ TaskID: id, CompletionAuthority: 'RunEvidence', ...extra });
const reviewer = (id, extra = {}) => taskRow({ TaskID: id, CompletionAuthority: 'IndependentReviewerAgent', ...extra });

async function startRun(url, taskId, agent = 'impl') {
  const result = await post(url, '/api/runs/start', { taskId, agent, verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.run.runId;
}
const artifact = (url, taskId, runId, name, content) => post(url, `/api/tasks/${taskId}/runs/${runId}/artifacts`, { name, content });
const close = (url, taskId, runId, extra = {}) => post(url, `/api/tasks/${taskId}/runs/${runId}/close`, { outcome: 'verified', summary: 'done', ...extra });
const task = async (url, taskId) => (await call(url, `/api/tasks/${taskId}/packet`)).body.task;
const statusOf = async (url, taskId) => (await task(url, taskId)).Status;

await runSuite('run-evidence', async () => {
  // ---- creation: RunEvidence is a Task/Bug authority, never a Story's --------------------------------
  {
    const { url } = await newHub([story('C-S')]);
    const newTask = (taskId, extra) => ({ taskId, taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'T', task: 'x', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent', priority: 'P1', acceptance: 'a', completionAuthority: 'RunEvidence', ...extra });
    const create = (payload) => post(url, '/api/tasks', { agent: 'p', reason: 'fixture', newTask: payload });
    assert.equal((await create(newTask('C-1'))).status, 201, 'Task + RunEvidence');
    assert.equal((await create(newTask('C-2', { taskType: 'Bug', parentId: 'C-S' }))).status, 201, 'Bug + RunEvidence under a Story');
    const storyWithEvidence = await create(newTask('C-3', { taskType: 'Story' }));
    assert.equal(storyWithEvidence.status, 422, 'a Story stays NotApplicable');
    const invalid = await create(newTask('C-4', { completionAuthority: 'Checks' }));
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /IndependentReviewerAgent, RunEvidence, DecisionOwner or NotApplicable/);
    assert.equal((await call(url, '/api/dependency-audit')).body.valid, true, 'the audit accepts RunEvidence');
    const health = (await call(url, '/api/health')).body;
    assert.equal(health.runEvidencePattern, '^RESULT: PASS\\b', 'the default pattern is published for tt');
    assert.equal(health.toolVersion, '1.5.0');
  }

  // ---- the standard chain: checks, checks, integration review ------------------------------------------
  {
    const { sandbox, url } = await newHub([
      story('S-1'),
      checks('T-1', { ParentID: 'S-1', Status: 'Ready' }),
      checks('T-2', { ParentID: 'S-1', DependsOn: 'T-1' }),
      reviewer('T-3', { ParentID: 'S-1', DependsOn: 'T-2' }),
    ]);
    const run1 = await startRun(url, 'T-1');
    assert.equal(await statusOf(url, 'T-2'), 'Blocked', 'starting T-1 arms its successor, as for reviewed work');

    // no artifact: refused, nothing changes
    const before = await readFile(sandbox.trackerPath, 'utf8');
    let refused = await close(url, 'T-1', run1);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, 'run-evidence-missing');
    assert.match(refused.body.error, /run the project check so reports\/last-check\.md contains "RESULT: PASS"/i);
    assert.match(refused.body.error, /or close as incomplete/);
    assert.equal(await readFile(sandbox.trackerPath, 'utf8'), before, 'a refused close leaves the CSV untouched');
    assert.equal(await statusOf(url, 'T-1'), 'In Progress');

    // a FAIL marker blocks, even next to a PASS marker in another artifact
    assert.equal((await artifact(url, 'T-1', run1, 'first-try.txt', 'parse ok\nRESULT: FAIL (test: 2 failed)\n')).status, 201);
    refused = await close(url, 'T-1', run1);
    assert.equal(refused.status, 422);
    assert.equal(refused.body.code, 'run-evidence-failed');
    assert.match(refused.body.error, /RESULT: FAIL.*first-try\.txt/);
    assert.equal((await artifact(url, 'T-1', run1, 'second-try.txt', 'RESULT: PASS (all tests)\n')).status, 201);
    refused = await close(url, 'T-1', run1);
    assert.equal(refused.status, 422, 'one FAIL artifact keeps the whole Run from auto-accepting');
    assert.equal(refused.body.code, 'run-evidence-failed');

    // the poisoned Run can only be blocked; park + admit give a clean second Run
    assert.equal((await close(url, 'T-1', run1, { outcome: 'blocked', blocker: 'check failed' })).status, 200);
    assert.equal(await statusOf(url, 'T-2'), 'Backlog', 'the armed successor is disarmed when the Run is blocked');
    assert.equal((await post(url, '/api/tasks/T-1/park', { agent: 'a', reason: 'reset' })).status, 200);
    assert.equal((await post(url, '/api/tasks/T-1/admit', { agent: 'a', targetStatus: 'Ready', reason: 'again' })).status, 200);
    const run2 = await startRun(url, 'T-1');
    assert.equal(run2, 'T-1-R0002');
    assert.equal((await artifact(url, 'T-1', run2, 'last-check.md', '# Check\n[PASS] parse\nRESULT: PASS (3 tests)\n')).status, 201);
    const done = await close(url, 'T-1', run2);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.task.Status, 'Done', 'RunEvidence goes straight to Done, never In Review');
    assert.equal(done.body.run.status, 'verified');
    assert.match(done.body.task.Evidence, /RUN T-1-R0002 verified: done\nauto-accepted: RunEvidence \(T-1-R0002, artifact last-check\.md\)$/);
    assert.equal(await statusOf(url, 'T-2'), 'Ready', 'the serial-lane successor advances as after an approval');
    assert.match((await task(url, 'T-2')).Evidence, /AUTO-ADVANCED: T-1 Done -> Ready/);
    assert.equal(await statusOf(url, 'S-1'), 'Backlog', 'the Story is not Done while Tasks remain');

    // second checks Task: a CRLF file with a UTF-8 BOM still matches; the integration Task becomes Ready
    const run3 = await startRun(url, 'T-2');
    assert.equal(await statusOf(url, 'T-3'), 'Blocked');
    assert.equal((await artifact(url, 'T-2', run3, 'check.log', `${BOM}RESULT: PASS (ok)\r\nmore\r\n`)).status, 201);
    assert.equal((await close(url, 'T-2', run3)).body.task.Status, 'Done');
    assert.equal(await statusOf(url, 'T-3'), 'Ready');

    // the integration Task is reviewed: In Review, not Done, and the Story stays open
    const run4 = await startRun(url, 'T-3');
    const reviewed = await close(url, 'T-3', run4);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.task.Status, 'In Review', 'reviewer-authority work still waits for independent review');
    assert.equal(await statusOf(url, 'S-1'), 'Backlog', 'a Story is not Done until the integration Task passed review');
    let summary = (await call(url, '/api/summary')).body;
    assert.deepEqual(summary.storyReview.gaps, []);
    assert.deepEqual(summary.storyReview.open, [{ storyId: 'S-1', title: 'Task S-1', milestone: 'M1', integrationTaskId: 'T-3', integrationStatus: 'In Review', checksDone: 2, checksTotal: 2 }]);
    assert.equal((await post(url, '/api/tasks/T-3/review', { action: 'claim', reviewer: 'impl' })).status, 409, 'the usual independence rule applies to the integration Task');
    assert.equal((await post(url, '/api/tasks/T-3/review', { action: 'claim', reviewer: 'story-reviewer' })).status, 200);
    const approved = await post(url, '/api/tasks/T-3/review', { action: 'decision', reviewer: 'story-reviewer', decision: 'approved', notes: 'integration verified' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(await statusOf(url, 'S-1'), 'Done', 'all children Done including the reviewed integration Task');
    summary = (await call(url, '/api/summary')).body;
    assert.deepEqual(summary.storyReview.open, [], 'the review is no longer open');
    const lines = (await call(url, '/api/tracker')).body.records.find((record) => record.TaskID === 'S-1').Evidence;
    assert.match(lines, /STORY STATUS SYNCHRONIZED: Backlog -> Done/);

    // RunEvidence tasks are not reviewable
    const notReviewable = await post(url, '/api/tasks/T-1/review', { action: 'claim', reviewer: 'someone' });
    assert.equal(notReviewable.status, 409);
    assert.match(notReviewable.body.error, /Only IndependentReviewerAgent work can be independently reviewed\. T-1 uses RunEvidence \(it completes on Run evidence/);
  }

  // ---- what counts as a passing marker ---------------------------------------------------------------------
  {
    const rows = [checks('E-0', { Status: 'Ready' })];
    for (let index = 1; index <= 12; index += 1) rows.push(checks(`E-${index}`, { Status: 'Ready' }));
    const { url } = await newHub(rows, { TASK_HUB_SERIAL_LANE: 'false' });
    const attempt = async (taskId, files) => {
      const runId = await startRun(url, taskId);
      for (const [name, content] of Object.entries(files)) assert.equal((await artifact(url, taskId, runId, name, content)).status, 201);
      return close(url, taskId, runId);
    };
    const refusedCases = {
      'E-1': { 'a.txt': 'not RESULT: PASS here' },
      'E-2': { 'a.txt': '  RESULT: PASS (indented)' },
      'E-3': { 'a.txt': 'RESULT: PASSED' },
      'E-4': { 'a.txt': 'result: pass' },
      'E-5': { 'a.txt': 'RESULT:PASS' },
      'E-6': { 'a.txt': 'RESULT: PASS\nRESULT: FAIL (one more check)\n' },
      'E-7': { 'a.txt': 'unrelated log' },
    };
    for (const [taskId, files] of Object.entries(refusedCases)) {
      const result = await attempt(taskId, files);
      assert.equal(result.status, 422, `${taskId} ${JSON.stringify(files)} must be refused`);
      assert.match(result.body.code, /^run-evidence-(missing|failed)$/);
    }
    const acceptedCases = {
      'E-8': { 'a.txt': 'noise\nRESULT: PASS (x)\nmore' },
      'E-9': { 'logs/check.txt': 'RESULT: PASS' },
      'E-10': { 'x.txt': 'unrelated', 'last-check.md': 'RESULT: PASS (ok)\n' },
      'E-11': { 'a.txt': `${BOM}RESULT: PASS (bom)` },
      'E-12': { 'a.txt': 'RESULT: PASS - tabs\tand (parens)' },
    };
    for (const [taskId, files] of Object.entries(acceptedCases)) {
      const result = await attempt(taskId, files);
      assert.equal(result.status, 200, `${taskId} ${JSON.stringify(files)} must be accepted: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.task.Status, 'Done');
    }
    const picked = await task(url, 'E-10');
    assert.match(picked.Evidence, /auto-accepted: RunEvidence \(E-10-R0001, artifact last-check\.md\)/, 'the evidence line names the matching artifact');
  }

  // ---- other outcomes, owner feedback, lane, owner-wait ---------------------------------------------------------
  {
    const { url } = await newHub([
      checks('O-1', { Status: 'Ready' }),
      reviewer('O-2', { Status: 'Backlog' }),
      taskRow({ TaskID: 'O-OWNER', CompletionAuthority: 'DecisionOwner', Status: 'Ready' }),
      taskRow({ TaskID: 'O-WAIT', CompletionAuthority: 'RunEvidence', Status: 'Backlog', DependsOn: 'O-1' }),
    ]);
    const run = await startRun(url, 'O-1');
    // the lane is occupied by the RunEvidence task: another agent task cannot be admitted, a DecisionOwner task can run
    const laneBlocked = await post(url, '/api/tasks/O-2/admit', { agent: 'a', targetStatus: 'Ready', reason: 'try' });
    assert.equal(laneBlocked.status, 409);
    assert.match(laneBlocked.body.error, /Serial lane is occupied by O-1 \(In Progress\)/);
    assert.equal((await startRun(url, 'O-OWNER', 'owner-prep')).startsWith('O-OWNER-R'), true);
    // incomplete keeps the Run active, awaiting-human hands the task to the owner
    assert.equal((await close(url, 'O-1', run, { outcome: 'incomplete', summary: 'check not run yet' })).body.task.Status, 'In Progress');
    const waiting = await close(url, 'O-1', run, { outcome: 'awaiting-human', ownerStatus: 'Awaiting Owner', summary: 'needs a decision' });
    assert.equal(waiting.status, 200);
    assert.equal(waiting.body.task.Status, 'Awaiting Owner');
    // owner feedback -> Awaiting Agent Evaluation -> resume (agent work) -> new Run -> evidence -> Done
    assert.equal((await post(url, '/api/feedback', { taskId: 'O-1', feedback: 'go ahead' })).status, 200);
    const resumed = await post(url, '/api/tasks/O-1/owner-feedback-disposition', { actor: 'a', action: 'resume', reason: 'owner agreed' });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.task.Status, 'Ready');
    const second = await startRun(url, 'O-1');
    await artifact(url, 'O-1', second, 'last-check.md', 'RESULT: PASS (2 tests)');
    assert.equal((await close(url, 'O-1', second)).body.task.Status, 'Done');
    // only DecisionOwner work can enter an owner wait
    const ownerWait = await post(url, '/api/tasks/O-WAIT/owner-wait', { agent: 'owner-prep', authorityTaskId: 'O-1', ownerStatus: 'Awaiting Owner', reason: 'prepare' });
    assert.equal(ownerWait.status, 409);
    assert.match(ownerWait.body.error, /Only an unclaimed DecisionOwner Backlog task can enter an owner wait/);
    // a DecisionOwner task still cannot close as verified
    const ownerRun = (await call(url, '/api/tasks/O-OWNER/packet')).body.packet.existingRuns[0].runId;
    const ownerVerified = await close(url, 'O-OWNER', ownerRun);
    assert.equal(ownerVerified.status, 409);
    assert.match(ownerVerified.body.error, /Only IndependentReviewerAgent or RunEvidence work can close as verified/);
  }

  // ---- the Story invariant is also a status rule and a report -------------------------------------------------------
  {
    const done = { Status: 'Done' };
    const { url } = await newHub([
      story('G-1'), checks('G-1a', { ParentID: 'G-1', ...done }),
      story('G-2'), checks('G-2a', { ParentID: 'G-2', ...done }), reviewer('G-2r', { ParentID: 'G-2', DependsOn: 'G-2a', ...done }),
      story('G-3'), checks('G-3a', { ParentID: 'G-3', ...done }), checks('G-3b', { ParentID: 'G-3', ...done }), reviewer('G-3r', { ParentID: 'G-3', DependsOn: 'G-3a', ...done }),
      story('G-4'), checks('G-4a', { ParentID: 'G-4', ...done }), checks('G-4b', { ParentID: 'G-4', DependsOn: 'G-4a', ...done }), reviewer('G-4r', { ParentID: 'G-4', DependsOn: 'G-4b', ...done }),
      story('G-5'), reviewer('G-5r', { ParentID: 'G-5', ...done }),
      story('G-6'), checks('G-6a', { ParentID: 'G-6', ...done }), taskRow({ TaskID: 'G-6o', ParentID: 'G-6', CompletionAuthority: 'DecisionOwner', ...done }),
      story('G-7'), checks('G-7a', { ParentID: 'G-7', Status: 'Ready' }), reviewer('G-7r', { ParentID: 'G-7', DependsOn: 'G-7a' }),
    ], { TASK_HUB_SERIAL_LANE: 'false' });
    const statuses = Object.fromEntries((await call(url, '/api/tracker')).body.records.filter((record) => record.TaskType === 'Story').map((record) => [record.TaskID, record.Status]));
    assert.deepEqual(statuses, {
      'G-1': 'Backlog', 'G-2': 'Done', 'G-3': 'Backlog', 'G-4': 'Done', 'G-5': 'Done', 'G-6': 'Backlog', 'G-7': 'Backlog',
    }, 'all-Done is not enough while the integration review is missing or does not cover every checks Task');
    const { gaps, open } = (await call(url, '/api/summary')).body.storyReview;
    assert.deepEqual(gaps.map((gap) => gap.storyId), ['G-1', 'G-3', 'G-6']);
    assert.match(gaps[0].message, /^Story G-1 has checks Tasks \(G-1a\) but no reviewer Task; add an integration-acceptance Task with Authority: reviewer/);
    assert.deepEqual(gaps[1].missing, ['G-3b']);
    assert.match(gaps[1].message, /no reviewer Task depends on all checks Tasks \(missing: G-3b\)/);
    assert.deepEqual(open.map((entry) => [entry.storyId, entry.integrationTaskId, entry.integrationStatus, entry.checksDone, entry.checksTotal]), [['G-7', 'G-7r', 'Backlog', 0, 1]]);
  }

  // ---- configuration: custom pattern, invalid pattern, missing key (= default) -----------------------------------------------
  {
    const template = JSON.parse(await readFile(join(repoRoot, 'task-hub.config.json'), 'utf8'));
    const withPattern = async (runEvidencePattern) => {
      const sandbox = await createSandbox('task-tracker-evidence-config-', []);
      sandboxes.push(sandbox);
      const configPath = join(sandbox.dir, 'config.json');
      const config = { ...template, workflow: { ...(template.workflow ?? {}), ...(runEvidencePattern === undefined ? {} : { runEvidencePattern }) } };
      if (runEvidencePattern === undefined) delete config.workflow.runEvidencePattern;
      await writeFile(configPath, JSON.stringify(config));
      return { sandbox, configPath };
    };
    // custom pattern
    {
      const { sandbox, configPath } = await withPattern('^OK\\b');
      await sandbox.writeTracker([checks('K-1', { Status: 'Ready' }), checks('K-2', { Status: 'Ready' })]);
      const { url, hub } = await (async () => {
        const hub = await startHub({ trackerPath: sandbox.trackerPath, env: { TASK_HUB_SERIAL_LANE: 'false', TASK_HUB_CONFIG: configPath } });
        hubs.push(hub);
        return { url: hub.url, hub };
      })();
      assert.equal((await call(url, '/api/health')).body.runEvidencePattern, '^OK\\b');
      const run = await startRun(url, 'K-1');
      await artifact(url, 'K-1', run, 'a.txt', 'RESULT: PASS (the default marker no longer counts)');
      assert.equal((await close(url, 'K-1', run)).status, 422);
      const run2 = await startRun(url, 'K-2');
      await artifact(url, 'K-2', run2, 'a.txt', 'OK: custom marker');
      assert.equal((await close(url, 'K-2', run2)).body.task.Status, 'Done');
      void hub;
    }
    // invalid or empty patterns stop the server with a clear message; a missing key means the default
    for (const bad of ['(', '', '   ', 42]) {
      const { sandbox, configPath } = await withPattern(bad);
      await sandbox.writeTracker([]);
      await assert.rejects(startHub({ trackerPath: sandbox.trackerPath, env: { TASK_HUB_CONFIG: configPath }, timeoutMs: 8_000 }), (error) => {
        assert.match(error.message, /workflow\.runEvidencePattern in task-hub\.config\.json is not usable/);
        return true;
      }, `pattern ${JSON.stringify(bad)} must be rejected`);
    }
    {
      const { sandbox, configPath } = await withPattern(undefined);
      assert.equal(JSON.parse(await readFile(configPath, 'utf8')).workflow.runEvidencePattern, undefined);
      await sandbox.writeTracker([checks('M-1', { Status: 'Ready' })]);
      const hub = await startHub({ trackerPath: sandbox.trackerPath, env: { TASK_HUB_SERIAL_LANE: 'false', TASK_HUB_CONFIG: configPath } });
      hubs.push(hub);
      assert.equal((await call(hub.url, '/api/health')).body.runEvidencePattern, '^RESULT: PASS\\b', 'a config without the key keeps the default');
    }
  }

  // ---- init-instance and the example config publish the pattern ---------------------------------------------------------------
  {
    const instance = await createInstance({ name: 'task-tracker-evidence-init-' });
    try {
      const written = JSON.parse(await readFile(join(instance.root, 'task-hub.config.json'), 'utf8'));
      assert.equal(written.workflow.runEvidencePattern, '^RESULT: PASS\\b', 'new instances state the pattern explicitly');
      const example = JSON.parse(await readFile(join(repoRoot, 'task-hub.config.example.json'), 'utf8'));
      assert.equal(example.workflow.runEvidencePattern, written.workflow.runEvidencePattern, 'the documented example matches what init writes');
      assert.equal(new RegExp(example.workflow.runEvidencePattern, 'm').test('log\nRESULT: PASS (12 tests)\n'), true);
    } finally {
      await instance.dispose();
    }
  }

  // ---- old trackers keep loading ---------------------------------------------------------------------------------------------
  {
    const { url } = await newHub([
      taskRow({ TaskID: 'L-1', Status: 'Ready' }),
      taskRow({ TaskID: 'L-2', CompletionAuthority: 'DecisionOwner' }),
      story('L-S'), taskRow({ TaskID: 'L-3', ParentID: 'L-S', Status: 'Done' }),
    ]);
    const tracker = await call(url, '/api/tracker');
    assert.equal(tracker.status, 200);
    assert.equal(tracker.body.records.find((record) => record.TaskID === 'L-S').Status, 'Done', 'Stories without checks Tasks derive their status as before');
    const summary = (await call(url, '/api/summary')).body;
    assert.deepEqual(summary.storyReview, { open: [], gaps: [] });
    // the CSV value is RunEvidence; the importer word "checks" is never stored
    const wrongSpelling = await newHub([taskRow({ TaskID: 'L-1', CompletionAuthority: 'Checks' })]);
    const audit = (await call(wrongSpelling.url, '/api/dependency-audit')).body;
    assert.equal(audit.valid, false);
    assert.equal(audit.csvErrors[0].code, 'completion-authority');
    assert.match(audit.csvErrors[0].message, /invalid CompletionAuthority 'Checks'/);
    assert.equal((await call(wrongSpelling.url, '/api/health')).body.ok, false, 'the tracker is reported unusable, not silently accepted');
  }
  console.log('run-evidence test passed: checks close in two calls to Done, FAIL/missing evidence refused, lane advance, Story review invariant, config, old trackers.');
}, async () => {
  for (const hub of hubs) { try { await hub.stop(); } catch { /* already gone */ } }
  for (const sandbox of sandboxes) await sandbox.dispose();
});
