#!/usr/bin/env node
// Windows write robustness: transient rename failures, stale/busy lock files,
// BOM + CRLF CSV, reserved device names as ids, normalized reviewer independence.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { call, createSandbox, mutation, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const hubs = [];
const sandboxes = [];

async function newHub(rows, env = {}) {
  const sandbox = await createSandbox('task-tracker-robust-', rows);
  sandboxes.push(sandbox);
  const hub = await startHub({ trackerPath: sandbox.trackerPath, env });
  hubs.push(hub);
  return { sandbox, hub };
}

const revisionOf = async (url) => (await call(url, '/api/dependency-audit')).body.revision;

function newTask(taskId, extra = {}) {
  return {
    taskId, taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'Test', task: `Created ${taskId}`, specRef: 'README.md',
    dependsOn: '', ownerRole: 'Agent', priority: 'P1', acceptance: 'Observable.', completionAuthority: 'IndependentReviewerAgent', ...extra,
  };
}

async function create(url, taskId, extra) {
  return call(url, '/api/tasks', mutation(url, { trackerRevision: await revisionOf(url), agent: 'planner', reason: 'test fixture', newTask: newTask(taskId, extra) }));
}

async function deadPid() {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(result.stdout);
}

const lockJson = (fields) => JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: 'test', ...fields });

await runSuite('windows-robustness', async () => {
  // ---- 1. transient EPERM on rename is retried and the write succeeds ----------------
  {
    const { sandbox, hub } = await newHub([taskRow({ TaskID: 'R-001', Status: 'Ready' })], { TASK_HUB_TEST_RENAME_EPERM: '3' });
    const result = await create(hub.url, 'R-002');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok((await readFile(sandbox.trackerPath, 'utf8')).includes('R-002'), 'the CSV must contain the new task');
    assert.equal(hub.stderr.filter((line) => /EPERM replacing task_tracker\.csv/.test(line)).length, 3, 'three retries must be logged');
    assert.deepEqual((await readdir(sandbox.dir)).filter((name) => name.endsWith('.tmp')), [], 'no temp files may remain');
  }

  // ---- 2. a persistent rename failure is a clean 500: CSV untouched, no temp left ------
  {
    const { sandbox, hub } = await newHub([taskRow({ TaskID: 'R-001', Status: 'Ready' })], { TASK_HUB_TEST_RENAME_EPERM: '1000' });
    const before = await readFile(sandbox.trackerPath, 'utf8');
    const started = Date.now();
    const result = await create(hub.url, 'R-002');
    assert.equal(result.status, 500);
    assert.match(result.body.error, /EPERM/);
    assert.ok(Date.now() - started >= 1_200, 'all retry delays (about 1.9 s) must be spent before giving up');
    assert.equal(await readFile(sandbox.trackerPath, 'utf8'), before, 'the CSV must be unchanged');
    assert.deepEqual((await readdir(sandbox.dir)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), [], 'no temp or lock files may remain');
  }

  // ---- 3. stale locks are replaced; live ones are reported with holder and age ----------
  {
    const { sandbox, hub } = await newHub([taskRow({ TaskID: 'L-001', Status: 'Ready' })]);
    const lockPath = `${sandbox.trackerPath}.lock`;

    // 3a. holder pid is dead (kill -9 of a previous server)
    await writeFile(lockPath, lockJson({ pid: await deadPid() }));
    let result = await create(hub.url, 'L-002');
    assert.equal(result.status, 201, `dead-pid lock must be replaced: ${JSON.stringify(result.body)}`);
    assert.ok(hub.stderr.some((line) => /replacing stale lock task_tracker\.csv\.lock \(holder pid \d+ is not running\)/.test(line)));
    assert.ok(!(await readdir(sandbox.dir)).includes('task_tracker.csv.lock'), 'lock must be released after the write');

    // 3b. holder looks alive but the lock is older than 120 s
    await writeFile(lockPath, lockJson({ createdAt: new Date(Date.now() - 300_000).toISOString() }));
    result = await create(hub.url, 'L-003');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok(hub.stderr.some((line) => /older than 120 s/.test(line)));

    // 3c. legacy empty lock (old server version) with an old mtime
    await writeFile(lockPath, '');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, longAgo, longAgo);
    result = await create(hub.url, 'L-004');
    assert.equal(result.status, 201, JSON.stringify(result.body));

    // 3d. live holder, fresh lock: genuinely busy -> 409 naming holder and age, lock untouched
    await writeFile(lockPath, lockJson({}));
    result = await create(hub.url, 'L-005');
    assert.equal(result.status, 409);
    assert.match(result.body.error, new RegExp(`pid ${process.pid} on ${hostname()}, taken \\d+s ago`));
    assert.equal(result.body.code, 'locked');
    assert.ok((await readdir(sandbox.dir)).includes('task_tracker.csv.lock'), 'a live lock must not be removed');

    // 3e. a fresh unreadable lock (its creator died between creating the file and writing it):
    //     the server waits for it to become readable or stale (~1.5 s) instead of failing the write
    await writeFile(lockPath, '');
    const waitStarted = Date.now();
    result = await create(hub.url, 'L-005');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok(Date.now() - waitStarted >= 1_000, 'the unreadable lock is given time before it is replaced');
    assert.ok(hub.stderr.some((line) => /\(unreadable lock file\)/.test(line)));

    // 3f. a lock from another host cannot be pid-checked: busy while young, replaced when old
    await writeFile(lockPath, lockJson({ host: 'some-other-machine', pid: await deadPid() }));
    result = await create(hub.url, 'L-006');
    assert.equal(result.status, 409);
    await writeFile(lockPath, lockJson({ host: 'some-other-machine', createdAt: new Date(Date.now() - 200_000).toISOString() }));
    result = await create(hub.url, 'L-006');
    assert.equal(result.status, 201, JSON.stringify(result.body));

    // 3g. the run lock and the toolchain-issue lock share the same recovery
    const started = await call(hub.url, '/api/runs/start', mutation(hub.url, {
      taskId: 'L-001', trackerRevision: await revisionOf(hub.url), agent: 'a1', verificationProfile: 'logic', scope: 's', expectedBehavior: 'e',
    }));
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const runLock = join(sandbox.dir, 'task-records', 'L-001', started.body.run.runId, '.run.lock');
    await writeFile(runLock, lockJson({ pid: await deadPid() }));
    const event = await call(hub.url, `/api/tasks/L-001/runs/${started.body.run.runId}/events`, mutation(hub.url, {
      trackerRevision: await revisionOf(hub.url), type: 'note', result: 'ok', message: 'run lock recovery',
    }));
    assert.equal(event.status, 201, JSON.stringify(event.body));
    await writeFile(join(sandbox.dir, 'toolchain_issue_events.jsonl.lock'), lockJson({ pid: await deadPid() }));
    const issue = await call(hub.url, '/api/toolchain-issues', mutation(hub.url, {
      taskId: 'L-001', failureKey: 'godot.headless.import-timeout', reporter: 'a1', toolchain: 'godot', operation: 'import', summary: 'lock recovery',
    }));
    assert.equal(issue.status, 201, JSON.stringify(issue.body));
  }

  // ---- 4. a CSV saved with BOM + CRLF (Excel "CSV UTF-8") is readable; writes are LF, no BOM ----
  {
    const sandbox = await createSandbox('task-tracker-bom-', []);
    sandboxes.push(sandbox);
    await sandbox.writeTracker([taskRow({ TaskID: 'B-001', Status: 'Ready', Task: '中文标题 with, comma' })], { bom: true, eol: '\r\n' });
    const hub = await startHub({ trackerPath: sandbox.trackerPath });
    hubs.push(hub);
    const packet = await call(hub.url, '/api/tasks/B-001/packet');
    assert.equal(packet.status, 200, JSON.stringify(packet.body));
    assert.equal(packet.body.task.Task, '中文标题 with, comma');
    assert.equal((await call(hub.url, '/api/dependency-audit')).body.valid, true);
    const result = await create(hub.url, 'B-002');
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const written = await readFile(sandbox.trackerPath);
    assert.notDeepEqual([...written.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'writes must not add a BOM');
    assert.ok(!written.includes(0x0D), 'writes must use LF only');
    assert.ok(written.toString('utf8').includes('中文标题'));
  }

  // ---- 5. ids that Windows cannot store as folders are rejected up front ----------------
  {
    const { sandbox, hub } = await newHub([taskRow({ TaskID: 'N-001', Status: 'Ready' })]);
    const before = await readFile(sandbox.trackerPath, 'utf8');
    for (const taskId of ['NUL', 'nul', 'CON', 'con.txt', 'Aux', 'PRN.log', 'COM1', 'com9.x', 'LPT1', 'lpt9', 'task.', 'N-001.', '..', '.']) {
      const result = await create(hub.url, taskId);
      assert.equal(result.status, 400, `${taskId} must be rejected (got ${result.status})`);
      assert.match(result.body.error, /reserved Windows device name|dots|end with/, taskId);
    }
    assert.equal(await readFile(sandbox.trackerPath, 'utf8'), before, 'rejected ids must not touch the CSV');
    assert.equal((await create(hub.url, 'N-001', { dependsOn: 'COM1' })).status, 400, 'a reserved dependency id is rejected too');
    assert.equal((await create(hub.url, 'N-002', { parentId: 'nul' })).status, 400);
    assert.equal((await call(hub.url, '/api/tasks/NUL/runs')).status, 400);
    for (const taskId of ['CON-001', 'COMMON', 'NULL-1', 'COM10', 'LPT0', 'AUX_1', 'x.nul']) {
      assert.equal((await create(hub.url, taskId)).status, 201, `${taskId} is a legal id`);
    }
  }

  // ---- 6. reviewer independence compares normalized names against every run agent ----------
  {
    const { hub } = await newHub([taskRow({ TaskID: 'V-001', Status: 'Ready' })]);
    const url = hub.url;
    const post = async (path, payload) => call(url, path, mutation(url, { trackerRevision: await revisionOf(url), ...payload }));
    const startRun = async (agent) => (await post('/api/runs/start', { taskId: 'V-001', agent, verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' })).body.run.runId;
    const closeRun = async (runId) => post(`/api/tasks/V-001/runs/${runId}/close`, { outcome: 'verified', summary: 'done' });
    const review = (reviewer, extra = {}) => post('/api/tasks/V-001/review', { reviewer, ...extra });

    let runId = await startRun('impl-lock');
    assert.equal((await closeRun(runId)).status, 200);
    for (const reviewer of ['impl-lock', 'IMPL-LOCK', '  Impl-Lock  ', '\uFF29MPL-LOCK', 'iMpL-lOcK']) {
      const result = await review(reviewer, { action: 'claim' });
      assert.equal(result.status, 409, `${JSON.stringify(reviewer)} must not review impl-lock`);
      assert.match(result.body.error, /distinct from the task Implementer and every agent that held a Run/);
      assert.equal(result.body.code, 'reviewer-not-independent');
    }
    // A genuinely different name claims; whitespace/case variants of it may decide, a prefix may not.
    assert.equal((await review('Review Bot', { action: 'claim' })).status, 200);
    const prefixOnly = await review('Review', { action: 'decision', decision: 'rejected', notes: 'prefix of the claimant must not pass' });
    assert.equal(prefixOnly.status, 409);
    assert.match(prefixOnly.body.error, /has not claimed/);
    const rejected = await review('  REVIEW   bot ', { action: 'decision', decision: 'rejected', notes: 'send it back' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.task.Status, 'Ready');

    // Second attempt by another agent: the first implementer still held a Run and may not review.
    runId = await startRun('second-agent');
    assert.equal((await closeRun(runId)).status, 200);
    const firstImplementer = await review('IMPL-lock', { action: 'claim' });
    assert.equal(firstImplementer.status, 409, 'an earlier Run agent may not review');
    assert.equal((await review('SECOND-AGENT', { action: 'claim' })).status, 409);
    assert.equal((await review('fresh-reviewer', { action: 'claim' })).status, 200);
    const approved = await review('Fresh-Reviewer', { action: 'decision', decision: 'approved', notes: 'looks right' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.task.Status, 'Done');
  }

  console.log('windows-robustness test passed: rename retry, stale/busy locks, BOM+CRLF, reserved ids, normalized reviewer independence.');
}, async () => {
  for (const hub of hubs) await hub.stop();
  for (const sandbox of sandboxes) await sandbox.dispose();
});
