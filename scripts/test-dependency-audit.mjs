#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-dependency-audit-'));
const trackerPath = join(sandbox, 'task_tracker.csv');
const header = ['TaskID', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'ReviewRequired', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];

function row(taskId, dependsOn = '', status = 'Backlog') {
  return [taskId, '', 'M1', 'Test', `${taskId} dependency audit`, 'README.md', dependsOn, 'Agent', status, 'P0', 'Dependency graph is valid.', 'Yes', '', '', '', '', '', ''];
}

async function writeRows(rows) {
  await writeFile(trackerPath, `${header.join(',')}\n${rows.map((values) => values.join(',')).join('\n')}\n`, 'utf8');
}

await writeRows([row('GRAPH-001', '', 'Ready'), row('GRAPH-002', 'GRAPH-001')]);
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', TASK_HUB_SERIAL_LANE: 'false', PORT: '0', HOST: '127.0.0.1', TRACKER_CSV: trackerPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const url = await new Promise((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for dependency-audit test server.')), 10_000);
  lines.on('line', (line) => {
    const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
    if (match) {
      clearTimeout(timeout);
      resolveUrl(match[1]);
    }
  });
  child.once('exit', (code) => reject(new Error(`Test server exited early with ${code}.`)));
});

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, options);
  return { response, body: await response.json() };
}

try {
  const valid = await request('/api/dependency-audit');
  assert.equal(valid.response.status, 200);
  assert.equal(valid.body.valid, true);
  assert.equal(valid.body.taskCount, 2);
  assert.equal(valid.body.edgeCount, 1);

  await writeRows([row('UNKNOWN-001', 'MISSING-001', 'Ready')]);
  const unknown = await request('/api/dependency-audit');
  assert.equal(unknown.response.status, 200);
  assert.equal(unknown.body.valid, false);
  assert.deepEqual(unknown.body.unknownDependencies, [{ taskId: 'UNKNOWN-001', dependencyId: 'MISSING-001' }]);

  await writeRows([row('SELF-001', 'SELF-001', 'Ready')]);
  const self = await request('/api/dependency-audit');
  assert.equal(self.response.status, 200);
  assert.deepEqual(self.body.selfDependencies, ['SELF-001']);

  await writeRows([row('CYCLE-B', 'CYCLE-A'), row('CYCLE-A', 'CYCLE-B', 'Ready')]);
  const twoNodeCycle = await request('/api/dependency-audit');
  assert.equal(twoNodeCycle.response.status, 200);
  assert.deepEqual(twoNodeCycle.body.cycles, [{ taskIds: ['CYCLE-A', 'CYCLE-B', 'CYCLE-A'], path: 'CYCLE-A -> CYCLE-B -> CYCLE-A' }]);

  await writeRows([row('LONG-C', 'LONG-A'), row('LONG-B', 'LONG-C'), row('LONG-A', 'LONG-B', 'Ready')]);
  const longCycle = await request('/api/dependency-audit');
  assert.equal(longCycle.response.status, 200);
  assert.deepEqual(longCycle.body.cycles, [{ taskIds: ['LONG-A', 'LONG-B', 'LONG-C', 'LONG-A'], path: 'LONG-A -> LONG-B -> LONG-C -> LONG-A' }]);

  const beforeRejectedMutation = await readFile(trackerPath, 'utf8');
  const rejectedMutation = await request('/api/runs/start', {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: 'LONG-A',
      trackerRevision: longCycle.body.revision,
      agent: 'dependency-audit-test',
      verificationProfile: 'A-Design',
      scope: 'Verify a cyclic graph cannot be mutated.',
      expectedBehavior: 'The Hub rejects the malformed graph before changing CSV state.',
    }),
  });
  assert.equal(rejectedMutation.response.status, 422);
  assert.match(rejectedMutation.body.error, /dependency cycle/i);
  assert.deepEqual(rejectedMutation.body.dependencyAudit.cycles, longCycle.body.cycles);
  assert.equal(await readFile(trackerPath, 'utf8'), beforeRejectedMutation);

  const malformed = [...row('WIDTH-001'), 'extra field'];
  await writeFile(trackerPath, `${header.join(',')}\n${malformed.join(',')}\n`, 'utf8');
  const rowWidth = await request('/api/dependency-audit');
  assert.equal(rowWidth.response.status, 200);
  assert.equal(rowWidth.body.valid, false);
  assert.equal(rowWidth.body.csvErrors[0].code, 'row-width');

  await writeFile(trackerPath, '', 'utf8');
  const empty = await request('/api/dependency-audit');
  assert.equal(empty.response.status, 200);
  assert.equal(empty.body.valid, false);
  assert.equal(empty.body.csvErrors[0].code, 'required-columns');

  console.log('dependency-audit test passed: valid graph, unknown/self/cycle diagnostics, deterministic paths, mutation rejection and malformed CSV reporting.');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
}
