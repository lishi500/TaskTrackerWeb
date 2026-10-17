#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-serial-'));
const trackerPath = join(sandbox, 'task_tracker.csv');
const recordsPath = join(sandbox, 'task-records');
const header = ['TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'CompletionAuthority', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];
const rows = [
  ['SER-001', 'Task', '', 'M1', 'Test', 'First Agent task', 'README.md', '', 'Agent', 'Ready', 'P0', 'Starts the serial lane', 'IndependentReviewerAgent', '', '', '', '', '', ''],
  ['GATE-SER-001', 'Task', '', 'M1', 'Test', 'Owner Gate', 'README.md', 'SER-001', 'Human decision owner', 'Backlog', 'P0', 'Receives owner evaluation', 'DecisionOwner', '', '', '', '', '', ''],
  ['SER-002', 'Task', '', 'M1', 'Test', 'Second Agent task', 'README.md', 'GATE-SER-001', 'Agent', 'Backlog', 'P0', 'Follows approved gate', 'IndependentReviewerAgent', '', '', '', '', '', ''],
  ['SER-003', 'Task', '', 'M1', 'Test', 'Third Agent task', 'README.md', 'SER-002', 'Agent', 'Backlog', 'P0', 'Is the only armed successor', 'IndependentReviewerAgent', '', '', '', '', '', ''],
  ['SER-004', 'Task', '', 'M1', 'Test', 'Fourth Agent task', 'README.md', 'SER-003', 'Agent', 'Backlog', 'P0', 'Remains backlog until predecessor starts', 'IndependentReviewerAgent', '', '', '', '', '', ''],
  ['DEC-SER-001', 'Task', '', 'M1', 'Test', 'Concurrent decision-owner task', 'README.md', '', 'Human decision owner', 'Ready', 'P1', 'May await a decision without occupying the independent-review serial lane', 'DecisionOwner', '', '', '', '', '', ''],
];
await mkdir(recordsPath, { recursive: true });
await writeFile(trackerPath, `${header.join(',')}\n${rows.map((row) => row.join(',')).join('\n')}\n`, 'utf8');

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', TASK_HUB_SERIAL_LANE: 'true', PORT: '0', HOST: '127.0.0.1', TRACKER_CSV: trackerPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const url = await new Promise((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for serial-lane test server.')), 10_000);
  lines.on('line', (line) => {
    const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
    if (match) { clearTimeout(timeout); resolveUrl(match[1]); }
  });
  child.once('exit', (code) => reject(new Error(`Test server exited early with ${code}.`)));
});

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, options);
  return { response, body: await response.json() };
}

const mutation = (payload) => ({ method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
async function packet(taskId) { return request(`/api/tasks/${taskId}/packet`); }
async function start(taskId) {
  const current = await packet(taskId);
  return request('/api/runs/start', mutation({ taskId, trackerRevision: current.body.trackerRevision, agent: 'serial-agent', verificationProfile: 'A-Design', scope: `Serial ${taskId}`, expectedBehavior: 'The Hub must control one-step serial admission.' }));
}
async function approveRun(taskId, runId, revision) {
  const close = await request(`/api/tasks/${taskId}/runs/${runId}/close`, mutation({ trackerRevision: revision, outcome: 'verified', summary: 'Serial-lane test implementation is verified.' }));
  assert.equal(close.response.status, 200);
  const claim = await request(`/api/tasks/${taskId}/review`, mutation({ trackerRevision: close.body.trackerRevision, action: 'claim', reviewer: 'serial-reviewer' }));
  assert.equal(claim.response.status, 200);
  return request(`/api/tasks/${taskId}/review`, mutation({ trackerRevision: claim.body.trackerRevision, action: 'decision', reviewer: 'serial-reviewer', decision: 'approved', notes: 'Independent serial-lane test review.' }));
}

try {
  const first = await start('SER-001');
  assert.equal(first.response.status, 201);
  const concurrentDecision = await start('DEC-SER-001');
  assert.equal(concurrentDecision.response.status, 201);
  const concurrentDecisionClose = await request(`/api/tasks/DEC-SER-001/runs/${concurrentDecision.body.run.runId}/close`, mutation({
    trackerRevision: concurrentDecision.body.trackerRevision,
    outcome: 'awaiting-human', ownerStatus: 'Awaiting Owner', summary: 'The decision owner must choose before this task can complete.',
  }));
  assert.equal(concurrentDecisionClose.response.status, 200);
  const armedGate = await packet('GATE-SER-001');
  assert.equal(armedGate.body.task.Status, 'Blocked');
  assert.match(armedGate.body.task.Evidence, /ARMED: waiting for active predecessor SER-001;/);
  assert.equal((await packet('SER-002')).body.task.Status, 'Backlog');

  const firstApproved = await approveRun('SER-001', first.body.run.runId, (await packet('SER-001')).body.trackerRevision);
  assert.equal(firstApproved.response.status, 200);
  assert.equal((await packet('GATE-SER-001')).body.task.Status, 'Awaiting Owner Gate');

  const gateFeedback = await packet('GATE-SER-001');
  const feedback = await request('/api/feedback', mutation({ taskId: 'GATE-SER-001', feedback: 'Approve the reviewed milestone packet.' , trackerRevision: gateFeedback.body.trackerRevision }));
  assert.equal(feedback.response.status, 200);
  assert.equal(feedback.body.record.Status, 'Awaiting Agent Evaluation');
  const evaluation = await request('/api/tasks/GATE-SER-001/owner-evaluation', mutation({ trackerRevision: feedback.body.trackerRevision, agent: 'evaluation-agent', decision: 'approved', notes: 'The Agent verified that the owner feedback is an approval.' }));
  assert.equal(evaluation.response.status, 200);
  assert.equal((await packet('SER-002')).body.task.Status, 'Ready');

  const second = await start('SER-002');
  assert.equal(second.response.status, 201);
  assert.equal((await packet('SER-003')).body.task.Status, 'Blocked');
  assert.equal((await packet('SER-004')).body.task.Status, 'Backlog');
  const premature = await packet('SER-004');
  const invalidAdmission = await request('/api/tasks/SER-004/admit', mutation({ trackerRevision: premature.body.trackerRevision, agent: 'scheduling-agent', targetStatus: 'Blocked', blocker: 'Attempt to skip the immediate successor.', reason: 'This must reject because SER-003 is not active.' }));
  assert.equal(invalidAdmission.response.status, 409);

  const secondApproved = await approveRun('SER-002', second.body.run.runId, second.body.trackerRevision);
  assert.equal(secondApproved.response.status, 200);
  assert.equal((await packet('SER-003')).body.task.Status, 'Ready');
  assert.equal((await packet('SER-004')).body.task.Status, 'Backlog');
  console.log('serial-lane test passed: serial independent-review lane, concurrent DecisionOwner handoff, owner evaluation, and skipped-successor rejection.');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
}
