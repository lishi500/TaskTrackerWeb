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
const header = ['TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'ReviewRequired', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];
const row = (TaskID, fields = {}) => ({ TaskID, TaskType: 'Task', Milestone: 'M1', Workstream: 'Slice', Task: TaskID, SpecRef: 'slice.md', OwnerRole: 'Agent', Status: 'Backlog', Priority: 'P1', Acceptance: 'Observe behavior in the target environment.', ReviewRequired: 'Yes', ...fields });
const records = [
  row('STORY-001', { TaskType: 'Story', ReviewRequired: 'No' }),
  row('IMPL-001', { ParentID: 'STORY-001', Status: 'Ready' }),
  row('VERIFY-001', { ParentID: 'STORY-001', DependsOn: 'IMPL-001' }),
  row('OWNER-001', { OwnerRole: 'Owner', ReviewRequired: 'No', Status: 'Awaiting Owner' }),
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
  async function post(path, payload) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
  const taskIds = (items) => items.map(({ TaskID }) => TaskID).sort();
  let summary = await get('/api/summary');
  assert.equal(summary.executableCount, 5);
  assert.equal(summary.storyCount, 1);
  assert.deepEqual(taskIds(summary.ownerActions), ['OWNER-001']);

  const ownerPacket = await get('/api/tasks/OWNER-001/packet');
  await post('/api/feedback', { taskId: 'OWNER-001', trackerRevision: ownerPacket.trackerRevision, feedback: 'The requested device is available.' });
  summary = await get('/api/summary');
  assert.deepEqual(summary.ownerActions, []);
  assert.deepEqual(taskIds(summary.currentWork), ['OWNER-001']);
  assert.equal(summary.currentWork[0].Status, 'Awaiting Agent Evaluation');
  const feedbackPacket = await get('/api/tasks/OWNER-001/packet');
  await post('/api/feedback', { taskId: 'OWNER-001', trackerRevision: feedbackPacket.trackerRevision, feedback: 'Additional device details.' });
  const evaluationPacket = await get('/api/tasks/OWNER-001/packet');
  assert.match(evaluationPacket.task.Evidence, /The requested device is available/);
  assert.match(evaluationPacket.task.Evidence, /Additional device details/);
  await post('/api/tasks/OWNER-001/owner-evaluation', { trackerRevision: evaluationPacket.trackerRevision, agent: 'coordinator', decision: 'return-to-owner', notes: 'Please supply the device unlock step.' });
  assert.deepEqual(taskIds((await get('/api/summary')).ownerActions), ['OWNER-001']);

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

  const closed = await post(`/api/tasks/IMPL-001/runs/${run.run.runId}/close`, { trackerRevision: run.trackerRevision, outcome: 'verified', summary: 'Fixture observation recorded; independent review required.' });
  assert.deepEqual(taskIds((await get('/api/summary')).dependencyWaits), ['VERIFY-001'], 'Review wait must not become an unexpected blocker.');
  const claimed = await post('/api/tasks/IMPL-001/review', { trackerRevision: closed.trackerRevision, action: 'claim', reviewer: 'independent-reviewer' });
  await post('/api/tasks/IMPL-001/review', { trackerRevision: claimed.trackerRevision, action: 'decision', reviewer: 'independent-reviewer', decision: 'approved', notes: 'The fixture evidence meets this test task contract.' });
  summary = await get('/api/summary');
  assert.deepEqual(summary.dependencyWaits, []);
  assert.equal((await get('/api/tasks/VERIFY-001/packet')).task.Status, 'Ready');
  assert.deepEqual(taskIds(summary.blockers), ['BROKEN-001', 'STALE-001']);
  assert.equal((await get('/api/tasks/STORY-001/packet')).task.Status, 'Backlog', 'Child completion must not complete the Story.');
  console.log('delivery context test passed: owner/Agent handoff, supplementary feedback, conservative wait classification, serial review advancement and read-only Story context.');
} finally {
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); }
  lines.close();
  await rm(sandbox, { recursive: true, force: true });
}
