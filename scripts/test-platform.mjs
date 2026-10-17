#!/usr/bin/env node
// Platform branches (win32 / darwin / linux) exercised on whatever machine runs the suite:
// the helpers in scripts/lib/platform.mjs are pure functions of `platform`, and the server
// can be started with an injected platform (TASK_HUB_TEST_PLATFORM, NODE_ENV=test only).

import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import {
  currentPlatform, idKey, isTransientFileError, isWindowsReservedName, linkRemovalMethod, pathsEqual, reservedNameSource, sameMachine, shortHostname, symlinkType,
} from './lib/platform.mjs';
import { reservedNameSource as tasksetReservedNameSource } from '../.agents/skills/game-task-hub/scripts/taskset.mjs';
import { call, createSandbox, mutation, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const platforms = ['win32', 'darwin', 'linux'];
const hubs = [];
const sandboxes = [];

// ---- pure helpers --------------------------------------------------------------------------
{
  const saved = { node: process.env.NODE_ENV, injected: process.env.TASK_HUB_TEST_PLATFORM };
  try {
    delete process.env.TASK_HUB_TEST_PLATFORM;
    assert.equal(currentPlatform(), process.platform, 'no injection: the real platform');
    process.env.TASK_HUB_TEST_PLATFORM = 'darwin';
    process.env.NODE_ENV = 'production';
    assert.equal(currentPlatform(), process.platform, 'injection is ignored outside NODE_ENV=test');
    process.env.NODE_ENV = 'test';
    assert.equal(currentPlatform(), 'darwin', 'NODE_ENV=test honours the injected platform');
  } finally {
    for (const [name, value] of [['NODE_ENV', saved.node], ['TASK_HUB_TEST_PLATFORM', saved.injected]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  assert.equal(isTransientFileError(code, 'win32'), true, `${code} is retried on Windows`);
  for (const platform of ['darwin', 'linux']) assert.equal(isTransientFileError(code, platform), false, `${code} is a real error on ${platform}`);
}
for (const platform of platforms) {
  for (const code of ['ENOENT', 'EEXIST', 'ENOTDIR', undefined]) assert.equal(isTransientFileError(code, platform), false, `${code} is never transient`);
}

assert.deepEqual(platforms.map((platform) => symlinkType(platform)), ['junction', 'dir', 'dir'], 'junction only on Windows');
assert.deepEqual(platforms.map((platform) => linkRemovalMethod(platform)), ['rmdir', 'unlink', 'unlink']);
assert.equal(pathsEqual('C:\\Users\\Me\\Game', 'c:\\users\\me\\game', 'win32'), true, 'NTFS paths compare ignoring case');
assert.equal(pathsEqual('/Users/me/Game', '/Users/me/game', 'darwin'), false, 'realpath already canonicalises the case on macOS');
assert.equal(pathsEqual('/home/me/a', '/home/me/a', 'linux'), true);
assert.equal(pathsEqual('/home/me/a', '/home/me/A', 'linux'), false, 'Linux paths are case-sensitive');

assert.equal(shortHostname('MacBook-Pro.local'), 'macbook-pro');
assert.equal(sameMachine('MacBook-Pro.local', 'macbook-pro.fritz.box'), true, 'a Mac keeps its lock holder identity across networks');
assert.equal(sameMachine('CARL-PC', 'carl-pc'), true);
assert.equal(sameMachine('build-1', 'build-2'), false);
assert.equal(sameMachine('', ''), false, 'an unknown host never matches');
assert.equal(sameMachine(undefined, 'x'), false);
assert.equal(idKey(' T-001 '), 't-001');

const reserved = ['CON', 'con', 'Nul.txt', 'COM1', 'com9.x', 'LPT1', 'lpt9.log', 'AUX', 'prn', 'aux.tar.gz'];
const legal = ['COM0', 'COM10', 'CONSOLE', 'NULL', 'x.nul', 'CON-001', 'LPT', 'COM', 'AUX_1', 'T-001'];
for (const name of reserved) assert.equal(isWindowsReservedName(name), true, `${name} is reserved on every platform`);
for (const name of legal) assert.equal(isWindowsReservedName(name), false, `${name} is a legal id`);
assert.equal(tasksetReservedNameSource, reservedNameSource, 'the importer (self-contained in the skill) and the server agree on reserved names');

await runSuite('platform', async () => {
  const start = async (rows, env) => {
    const sandbox = await createSandbox('task-tracker-platform-', rows);
    sandboxes.push(sandbox);
    const hub = await startHub({ trackerPath: sandbox.trackerPath, env });
    hubs.push(hub);
    return { sandbox, hub };
  };
  const newTask = (taskId) => ({
    taskId, taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'T', task: 'x', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'a', completionAuthority: 'IndependentReviewerAgent',
  });
  const create = async (url, taskId) => {
    const revision = (await call(url, '/api/dependency-audit')).body.revision;
    return call(url, '/api/tasks', mutation(url, { trackerRevision: revision, agent: 'p', reason: 'platform test', newTask: newTask(taskId) }));
  };

  // ---- rename retry is a Windows behaviour; POSIX fails fast with the real error ------------------
  for (const platform of ['linux', 'darwin']) {
    const { sandbox, hub } = await start([taskRow({ TaskID: 'P-001' })], { TASK_HUB_TEST_PLATFORM: platform, TASK_HUB_TEST_RENAME_EPERM: '1' });
    assert.equal((await call(hub.url, '/api/health')).body.platform, platform, 'health reports the platform the server behaves as');
    const before = await readFile(sandbox.trackerPath, 'utf8');
    const started = Date.now();
    const failed = await create(hub.url, 'P-002');
    assert.equal(failed.status, 500, `${platform}: EPERM is not retried`);
    assert.match(failed.body.error, /^EPERM: .*Check that the Hub may write to the tracker folder\./);
    assert.ok(Date.now() - started < 1_000, `${platform}: no retry delay was spent`);
    assert.ok(!hub.stderr.some((line) => /replacing .* retrying/.test(line)), 'no retry was logged');
    assert.equal(await readFile(sandbox.trackerPath, 'utf8'), before, 'the CSV is untouched');
    assert.equal((await create(hub.url, 'P-002')).status, 201, 'the next write succeeds once the injected fault is spent');
  }
  {
    const { sandbox, hub } = await start([taskRow({ TaskID: 'P-001' })], { TASK_HUB_TEST_PLATFORM: 'win32', TASK_HUB_TEST_RENAME_EPERM: '2' });
    const result = await create(hub.url, 'P-002');
    assert.equal(result.status, 201, 'win32 retries a transient EPERM');
    assert.equal(hub.stderr.filter((line) => /EPERM replacing task_tracker\.csv/.test(line)).length, 2);
    assert.ok((await readFile(sandbox.trackerPath, 'utf8')).includes('P-002'));
  }

  // ---- a lock holder on the same machine under another network name is still recognised -----------
  {
    const { sandbox, hub } = await start([taskRow({ TaskID: 'L-001' })], {});
    const { spawnSync } = await import('node:child_process');
    const { writeFile } = await import('node:fs/promises');
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    const sameMachineOtherDomain = `${shortHostname(hostname())}.some-other-network.example`;
    await writeFile(`${sandbox.trackerPath}.lock`, JSON.stringify({ pid: dead, host: sameMachineOtherDomain, createdAt: new Date().toISOString(), token: 't' }));
    const replaced = await create(hub.url, 'L-002');
    assert.equal(replaced.status, 201, 'same short host name + dead pid: stale lock is replaced right away');
    await writeFile(`${sandbox.trackerPath}.lock`, JSON.stringify({ pid: dead, host: 'definitely-not-this-machine', createdAt: new Date().toISOString(), token: 't' }));
    assert.equal((await create(hub.url, 'L-003')).status, 409, 'another machine: the pid cannot be checked, the lock is busy');
  }

  // ---- ids: reserved names on every platform, uniqueness ignoring case ------------------------------
  for (const platform of ['linux', 'darwin']) {
    const { hub } = await start([taskRow({ TaskID: 'I-001' })], { TASK_HUB_TEST_PLATFORM: platform });
    for (const taskId of ['NUL', 'con.txt', 'COM1']) {
      const refused = await create(hub.url, taskId);
      assert.equal(refused.status, 400, `${platform}: ${taskId} is refused so repositories can move to Windows`);
      assert.equal(refused.body.code, 'invalid-id');
    }
    const duplicate = await create(hub.url, 'i-001');
    assert.equal(duplicate.status, 409, `${platform}: I-001 and i-001 would share a folder on case-insensitive file systems`);
    assert.equal(duplicate.body.code, 'duplicate-id');
    assert.match(duplicate.body.error, /collides with the existing task 'I-001'.*ignoring case/);
    const exact = await create(hub.url, 'I-001');
    assert.equal(exact.status, 409);
    assert.match(exact.body.error, /already exists/);
    assert.equal((await create(hub.url, 'I-002')).status, 201);
  }

  console.log('platform test passed: injectable platform helpers, win32 retry vs POSIX fail-fast, host-name tolerance, reserved ids everywhere, case-insensitive id uniqueness.');
}, async () => {
  for (const hub of hubs) await hub.stop();
  for (const sandbox of sandboxes) await sandbox.dispose();
});
