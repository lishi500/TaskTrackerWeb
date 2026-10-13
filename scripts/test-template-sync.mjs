#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-template-sync-'));
const instance = join(sandbox, 'existing-instance');
await mkdir(join(instance, 'tracker'), { recursive: true });
await writeFile(join(instance, 'server.mjs'), '// stale shared server\n', 'utf8');
await writeFile(join(instance, 'task-hub.config.json'), '{"projectName":"Instance-owned config"}\n', 'utf8');
await writeFile(join(instance, 'tracker', 'task_tracker.csv'), 'TaskID,Status\nINSTANCE-001,Ready\n', 'utf8');

function run(...args) {
  return spawnSync(process.execPath, ['scripts/sync-template.mjs', '--target', instance, ...args], { cwd: root, encoding: 'utf8' });
}

try {
  const check = run();
  assert.equal(check.status, 0, check.stderr);
  const checkResult = JSON.parse(check.stdout);
  assert.equal(checkResult.mode, 'check');
  assert.equal(checkResult.sharedPaths.find(({ path }) => path === 'server.mjs').status, 'different');
  assert.equal(await readFile(join(instance, 'server.mjs'), 'utf8'), '// stale shared server\n');

  const apply = run('--apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).mode, 'applied');
  assert.equal(await readFile(join(instance, 'server.mjs'), 'utf8'), await readFile(new URL('../server.mjs', import.meta.url), 'utf8'));
  assert.equal(await readFile(join(instance, 'task-hub.config.json'), 'utf8'), '{"projectName":"Instance-owned config"}\n');
  assert.equal(await readFile(join(instance, 'tracker', 'task_tracker.csv'), 'utf8'), 'TaskID,Status\nINSTANCE-001,Ready\n');
  console.log('template-sync test passed: check is non-mutating; apply updates only declared generic paths and preserves instance state/config.');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
