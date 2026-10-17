#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-context-'));
const trackerPath = join(sandbox, 'task_tracker.csv');
const header = ['TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'CompletionAuthority', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];
const row = (TaskID, fields = {}) => ({ TaskID, TaskType: 'Task', Milestone: 'M1', Workstream: 'Slice', Task: TaskID, SpecRef: 'slice.md', OwnerRole: 'Agent', Status: 'Backlog', Priority: 'P1', Acceptance: 'Observe behavior in the target environment.', CompletionAuthority: 'IndependentReviewerAgent', ...fields });
const records = [
  row('STORY-001', { TaskType: 'Story', CompletionAuthority: 'NotApplicable' }),
  row('STORY-CACHED-001', { TaskType: 'Story', CompletionAuthority: 'NotApplicable' }),
  row('CACHED-001', { ParentID: 'STORY-CACHED-001', Status: 'Done' }),
  row('IMPL-001', { ParentID: 'STORY-001', Status: 'Ready' }),
  row('VERIFY-001', { ParentID: 'STORY-001', DependsOn: 'IMPL-001' }),
  row('OWNER-001', { OwnerRole: 'Human decision owner', CompletionAuthority: 'DecisionOwner', Status: 'Awaiting Owner' }),
  row('IMPL-BLOCK-001', { Status: 'Awaiting Owner' }),
  row('IMPL-RETURN-001', { Status: 'Awaiting Owner' }),
  row('BROKEN-001', { TaskType: 'Bug', Status: 'Blocked', Blocker: 'Target device unavailable.' }),
  // A historical arm marker must not hide a later independent blocker.
  row('STALE-001', { Status: 'Blocked', DependsOn: 'IMPL-001', Blocker: 'Missing test materials.', Evidence: 'ARMED: waiting for active predecessor IMPL-001; old' }),
];
const encode = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
await writeFile(trackerPath, `${header.join(',')}\n${records.map((record) => header.map((key) => encode(record[key])).join(',')).join('\n')}\n`);
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', TASK_HUB_SERIAL_LANE: 'true', PORT: '0', HOST: '127.0.0.1', TRACKER_CSV: trackerPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
try {
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for context test server.')), 10_000);
    lines.on('line', (line) => {
      const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match) { clearTimeout(timer); resolveUrl(match[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited with ${code}.`)); });
  });
  async function get(path) {
    const response = await fetch(`${url}${path}`);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  async function mutation(path, payload) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await response.json();
    return { response, body };
  }
  async function post(path, payload) {
    const { response, body } = await mutation(path, payload);
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
  const taskIds = (items) => items.map(({ TaskID }) => TaskID).sort();
  let summary = await get('/api/summary');
  assert.equal(summary.executableCount, 8);
  assert.equal(summary.storyCount, 2);
  assert.deepEqual(taskIds(summary.ownerActions), ['IMPL-BLOCK-001', 'IMPL-RETURN-001', 'OWNER-001']);
  const sourceBeforeProjection = await readFile(trackerPath, 'utf8');
  const projectedTracker = await get('/api/tracker');
  assert.equal(projectedTracker.records.find(({ TaskID }) => TaskID === 'STORY-CACHED-001').Status, 'Done');
  assert.equal(await readFile(trackerPath, 'utf8'), sourceBeforeProjection, 'Story projection is read-only until an authorized tracker mutation.');

  const ownerPacket = await get('/api/tasks/OWNER-001/packet');
  await post('/api/feedback', { taskId: 'OWNER-001', trackerRevision: ownerPacket.trackerRevision, feedback: 'The requested device is available.' });
  summary = await get('/api/summary');
  assert.deepEqual(taskIds(summary.ownerActions), ['IMPL-BLOCK-001', 'IMPL-RETURN-001']);
  assert.deepEqual(taskIds(summary.currentWork), ['OWNER-001']);
  assert.equal(summary.currentWork[0].Status, 'Awaiting Agent Evaluation');
  const feedbackPacket = await get('/api/tasks/OWNER-001/packet');
  await post('/api/feedback', { taskId: 'OWNER-001', trackerRevision: feedbackPacket.trackerRevision, feedback: 'Additional device details.' });
  const evaluationPacket = await get('/api/tasks/OWNER-001/packet');
  assert.match(evaluationPacket.task.Evidence, /The requested device is available/);
  assert.match(evaluationPacket.task.Evidence, /Additional device details/);
  await post('/api/tasks/OWNER-001/owner-evaluation', { trackerRevision: evaluationPacket.trackerRevision, agent: 'evaluation-agent', decision: 'return-to-owner', notes: 'Please supply the device unlock step.' });
  assert.deepEqual(taskIds((await get('/api/summary')).ownerActions), ['IMPL-BLOCK-001', 'IMPL-RETURN-001', 'OWNER-001']);

  const packet = await get('/api/tasks/IMPL-001/packet');
  const run = await post('/api/runs/start', { taskId: 'IMPL-001', trackerRevision: packet.trackerRevision, agent: 'implementer', verificationProfile: 'runtime', scope: 'One integrated behavior.', expectedBehavior: 'Observe the result in the real scene.' });
  summary = await get('/api/summary');
  assert.deepEqual(taskIds(summary.dependencyWaits), ['VERIFY-001']);
  assert.deepEqual(taskIds(summary.blockers), ['BROKEN-001', 'STALE-001']);
  const verifyPacket = await get('/api/tasks/VERIFY-001/packet');
  assert.equal(verifyPacket.task.Status, 'Blocked');
  const bytes = await readFile(trackerPath, 'utf8');
  await get('/api/summary');
  assert.equal(await readFile(trackerPath, 'utf8'), bytes, 'Summary is derived, not a state mutation.');

  const ownerWait = await post(`/api/tasks/IMPL-001/runs/${run.run.runId}/close`, {
    trackerRevision: run.trackerRevision,
    outcome: 'awaiting-human',
    ownerStatus: 'Awaiting Owner',
    summary: 'Fixture implementation needs owner confirmation before the final verification pass.',
  });
  await post('/api/feedback', {
    taskId: 'IMPL-001',
    trackerRevision: ownerWait.trackerRevision,
    feedback: 'The owner confirmed the required behavior; rerun the implementation and independent review.',
  });
  const agentEvaluationPacket = await get('/api/tasks/IMPL-001/packet');
  assert.equal(agentEvaluationPacket.task.Status, 'Awaiting Agent Evaluation');
  const forbiddenEvaluation = await mutation('/api/tasks/IMPL-001/owner-evaluation', {
    trackerRevision: agentEvaluationPacket.trackerRevision,
    agent: 'evaluation-agent', decision: 'approved', notes: 'An independently reviewed task must not complete through owner evaluation.',
  });
  assert.equal(forbiddenEvaluation.response.status, 409);
  const resumed = await post('/api/tasks/IMPL-001/owner-feedback-disposition', {
    trackerRevision: agentEvaluationPacket.trackerRevision,
    actor: 'disposition-agent',
    action: 'resume',
    reason: 'Owner feedback requires a fresh managed implementation pass followed by independent review.',
  });
  assert.equal(resumed.task.Status, 'Ready');
  assert.equal(resumed.task.Blocker, '');
  assert.equal(resumed.task.Implementer, '');
  assert.match(resumed.task.Evidence, /OWNER FEEDBACK DISPOSITION resume: disposition-agent/);
  const rerun = await post('/api/runs/start', { taskId: 'IMPL-001', trackerRevision: resumed.trackerRevision, agent: 'implementer', verificationProfile: 'runtime', scope: 'Owner-confirmed integrated behavior.', expectedBehavior: 'Observe the confirmed result in the real scene.' });
  const closed = await post(`/api/tasks/IMPL-001/runs/${rerun.run.runId}/close`, { trackerRevision: rerun.trackerRevision, outcome: 'verified', summary: 'Owner-confirmed fixture observation recorded; independent review required.' });
  assert.deepEqual(taskIds((await get('/api/summary')).dependencyWaits), ['VERIFY-001'], 'Review wait must not become an unexpected blocker.');
  const claimed = await post('/api/tasks/IMPL-001/review', { trackerRevision: closed.trackerRevision, action: 'claim', reviewer: 'independent-reviewer' });
  await post('/api/tasks/IMPL-001/review', { trackerRevision: claimed.trackerRevision, action: 'decision', reviewer: 'independent-reviewer', decision: 'approved', notes: 'The fixture evidence meets this test task contract.' });
  summary = await get('/api/summary');
  assert.deepEqual(summary.dependencyWaits, []);
  assert.equal((await get('/api/tasks/VERIFY-001/packet')).task.Status, 'Ready');
  const verifyRun = await post('/api/runs/start', { taskId: 'VERIFY-001', trackerRevision: (await get('/api/tasks/VERIFY-001/packet')).trackerRevision, agent: 'verify-implementer', verificationProfile: 'runtime', scope: 'Verify the completed Story slice.', expectedBehavior: 'Observe the final scoped behavior in the target scene.' });
  const verifyClosed = await post(`/api/tasks/VERIFY-001/runs/${verifyRun.run.runId}/close`, { trackerRevision: verifyRun.trackerRevision, outcome: 'verified', summary: 'Final Story-child verification recorded for independent review.' });
  const verifyClaimed = await post('/api/tasks/VERIFY-001/review', { trackerRevision: verifyClosed.trackerRevision, action: 'claim', reviewer: 'verify-reviewer' });
  await post('/api/tasks/VERIFY-001/review', { trackerRevision: verifyClaimed.trackerRevision, action: 'decision', reviewer: 'verify-reviewer', decision: 'approved', notes: 'The remaining direct child meets its task contract.' });
  const completedStory = await get('/api/tasks/STORY-001/packet');
  assert.equal(completedStory.task.Status, 'Done');
  assert.match(completedStory.task.Evidence, /STORY STATUS SYNCHRONIZED: Backlog -> Done/);
  const reopened = await post('/api/tasks', {
    trackerRevision: completedStory.trackerRevision,
    agent: 'planning-agent',
    reason: 'A newly discovered scoped follow-up must reopen the Story progress.',
    newTask: {
      taskId: 'STORY-REOPEN-001', taskType: 'Task', parentId: 'STORY-001', milestone: 'M1', workstream: 'Slice',
      task: 'Complete the newly discovered scoped follow-up', specRef: 'slice.md', dependsOn: '', ownerRole: 'Agent', priority: 'P1',
      acceptance: 'The follow-up has an independent executable contract.', completionAuthority: 'IndependentReviewerAgent',
    },
  });
  assert.equal(reopened.task.Status, 'Backlog');
  const reopenedStory = await get('/api/tasks/STORY-001/packet');
  assert.equal(reopenedStory.task.Status, 'Backlog');
  assert.match(reopenedStory.task.Evidence, /STORY STATUS SYNCHRONIZED: Done -> Backlog/);
  const blockPacket = await get('/api/tasks/IMPL-BLOCK-001/packet');
  await post('/api/feedback', { taskId: 'IMPL-BLOCK-001', trackerRevision: blockPacket.trackerRevision, feedback: 'The required source material is unavailable.' });
  const blockedDispositionPacket = await get('/api/tasks/IMPL-BLOCK-001/packet');
  const missingBlocker = await mutation('/api/tasks/IMPL-BLOCK-001/owner-feedback-disposition', {
    trackerRevision: blockedDispositionPacket.trackerRevision, actor: 'disposition-agent', action: 'blocked', reason: 'A concrete blocker is required.',
  });
  assert.equal(missingBlocker.response.status, 400);
  const blockedDisposition = await post('/api/tasks/IMPL-BLOCK-001/owner-feedback-disposition', {
    trackerRevision: blockedDispositionPacket.trackerRevision, actor: 'disposition-agent', action: 'blocked', blocker: 'The source material is still unavailable.', reason: 'Feedback confirms that execution cannot continue yet.',
  });
  assert.equal(blockedDisposition.task.Status, 'Blocked');
  assert.equal(blockedDisposition.task.Blocker, 'The source material is still unavailable.');
  assert.match(blockedDisposition.task.Evidence, /OWNER FEEDBACK DISPOSITION blocked: disposition-agent/);
  const returnPacket = await get('/api/tasks/IMPL-RETURN-001/packet');
  await post('/api/feedback', { taskId: 'IMPL-RETURN-001', trackerRevision: returnPacket.trackerRevision, feedback: 'Which visual direction should the rerun use?' });
  const returnDispositionPacket = await get('/api/tasks/IMPL-RETURN-001/packet');
  const missingReturnStatus = await mutation('/api/tasks/IMPL-RETURN-001/owner-feedback-disposition', {
    trackerRevision: returnDispositionPacket.trackerRevision, actor: 'disposition-agent', action: 'return-to-owner', reason: 'The owner-facing status is required.',
  });
  assert.equal(missingReturnStatus.response.status, 400);
  const returnedToOwner = await post('/api/tasks/IMPL-RETURN-001/owner-feedback-disposition', {
    trackerRevision: returnDispositionPacket.trackerRevision, actor: 'disposition-agent', action: 'return-to-owner', ownerStatus: 'Awaiting Owner Gate', reason: 'The feedback requests a product decision before implementation can continue.',
  });
  assert.equal(returnedToOwner.task.Status, 'Awaiting Owner Gate');
  assert.match(returnedToOwner.task.Evidence, /OWNER FEEDBACK DISPOSITION return-to-owner: disposition-agent/);
  summary = await get('/api/summary');
  assert.deepEqual(taskIds(summary.blockers), ['BROKEN-001', 'IMPL-BLOCK-001', 'STALE-001']);
  assert.deepEqual(taskIds(summary.ownerActions), ['IMPL-RETURN-001', 'OWNER-001']);
  assert.equal((await get('/api/tasks/STORY-001/packet')).task.Status, 'Backlog', 'A newly planned direct child must reopen the Story.');
  console.log('delivery context test passed: completion authority, owner-feedback dispositions, independent review, derived Story completion/reopen, conservative wait classification, serial review advancement and read-only Story projection.');
} finally {
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); }
  lines.close();
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => { /* a busy temp folder is not a test failure */ });
}
