#!/usr/bin/env node
// Fixed port + URL discovery files + start.mjs --detach + init-instance flags.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { call, createInstance, getFreePort, runSuite, waitFor } from './lib/test-support.mjs';
import { derivePort, nextPortInRange, parsePortNumber } from './lib/hub-port.mjs';

const instances = [];
const dummyServers = [];
const children = [];

async function newInstance(options) {
  const instance = await createInstance(options);
  instances.push(instance);
  return instance;
}

function occupy(port) {
  return new Promise((resolveServer, reject) => {
    // Accept and immediately drop connections (a "foreign program" that does not speak HTTP).
    const dummy = createNetServer((socket) => { socket.on('error', () => {}); socket.destroy(); });
    dummy.once('error', reject);
    dummy.listen(port, '127.0.0.1', () => { dummyServers.push(dummy); resolveServer(dummy); });
  });
}

// Run `node server.mjs` of an instance with an explicit environment (no PORT unless given).
async function launch(instance, env = {}) {
  const base = { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', ...env };
  if (!('PORT' in env)) delete base.PORT;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: instance.root, env: base, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const stdout = [];
  const stderr = [];
  createInterface({ input: child.stdout }).on('line', (line) => stdout.push(line));
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  const exited = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)));
  return { child, stdout, stderr, exited };
}

const announced = (run) => run.stdout.map((line) => /(?:available|already running) at (http:\/\/\S+)/.exec(line)?.[1]).find(Boolean);

await runSuite('start-init', async () => {
  // ---- port helpers -------------------------------------------------------------------
  assert.equal(derivePort('my-game'), derivePort('  My-Game '), 'derivation ignores case and surrounding spaces');
  for (const id of ['my-game', 'fishing', 'a1', 'zz-top', 'uninitialized']) {
    const derived = derivePort(id);
    assert.ok(derived >= 4300 && derived <= 4999, `${id} -> ${derived}`);
    assert.equal(derived, 4300 + (createHash('sha256').update(id).digest().readUInt32BE(0) % 700));
  }
  assert.equal(nextPortInRange(4999), 4300);
  assert.equal(nextPortInRange(4300), 4301);
  assert.throws(() => parsePortNumber('70000', 'PORT'), /between 1 and 65535/);
  assert.throws(() => parsePortNumber('0', 'PORT'), /between 1 and 65535/);
  assert.equal(parsePortNumber('0', 'PORT', { allowZero: true }), 0);
  assert.throws(() => parsePortNumber('80x', 'PORT'), /integer port/);

  // ---- init-instance ---------------------------------------------------------------------
  const empty = await newInstance({ projectId: 'demo-game', projectName: '演示 Game', port: 4891, empty: true });
  const config = JSON.parse(await readFile(join(empty.root, 'task-hub.config.json'), 'utf8'));
  assert.equal(config.instance.port, 4891);
  assert.equal(config.instance.projectName, '演示 Game');
  assert.equal(config.instance.projectId, 'demo-game');
  assert.equal(config.workflow.serialLane, true);
  const csv = await readFile(empty.trackerPath, 'utf8');
  assert.equal(csv.split('\n').length, 2, '--empty writes only the header row');
  assert.ok(csv.startsWith('TaskID,TaskType,ParentID,Milestone,') && csv.endsWith('\n') && !csv.includes('\r'));
  assert.equal(await readFile(join(empty.trackerDir, '.gitignore'), 'utf8'), '.tracker-url\n.tracker-pid\nserver.log\n*.lock\n*.tmp\n');
  assert.ok(existsSync(join(empty.trackerDir, 'task-records')));
  let result = empty.node('scripts/init-instance.mjs', ['--project-id', 'demo-game', '--project-name', 'x']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /init-instance: this instance is already initialized - .*never overwritten - try: node scripts\/start\.mjs --detach/);

  const sample = await newInstance({ projectId: 'sample-game', empty: false });
  const sampleCsv = await readFile(sample.trackerPath, 'utf8');
  assert.ok(sampleCsv.includes('STORY-001') && sampleCsv.includes('IMPL-001'), 'without --empty the skeleton rows are copied');
  assert.ok(!sampleCsv.includes('\r'), 'the skeleton is written with LF even if the template was checked out with CRLF');

  // default port: derived from the project id, inside the range (moved up when busy)
  const bare = await newInstance({ projectId: 'derived-game', port: undefined });
  // createInstance always passes --port, so call init-instance directly for the default branch.
  const raw = spawnSync(process.execPath, [join(bare.root, 'scripts', 'init-instance.mjs'), '--project-id', 'derived-two', '--project-name', 'Derived', '--root', join(bare.root, 'sub')], { encoding: 'utf8' });
  assert.equal(raw.status, 0, raw.stderr);
  const derivedPort = JSON.parse(await readFile(join(bare.root, 'sub', 'task-hub.config.json'), 'utf8')).instance.port;
  assert.ok(derivedPort >= 4300 && derivedPort <= 4999);
  assert.match(raw.stdout, new RegExp(`port: ${derivedPort} \\(derived from the project id.*\\)  url: http://127\\.0\\.0\\.1:${derivedPort}`));

  const dummyForInit = await occupy(derivePort('busy-derived'));
  const busy = spawnSync(process.execPath, [join(bare.root, 'scripts', 'init-instance.mjs'), '--project-id', 'busy-derived', '--project-name', 'Busy', '--root', join(bare.root, 'busy')], { encoding: 'utf8' });
  assert.equal(busy.status, 0, busy.stderr);
  const busyPort = JSON.parse(await readFile(join(bare.root, 'busy', 'task-hub.config.json'), 'utf8')).instance.port;
  assert.notEqual(busyPort, derivePort('busy-derived'), 'a busy derived port is skipped');
  assert.match(busy.stdout, /moved because the first choice is busy/);
  dummyForInit.close();

  for (const [args, pattern] of [
    [['--project-id', 'ok-id', '--project-name', 'N', '--port', '99999'], /--port is invalid - .*between 1 and 65535/],
    [['--project-id', 'ok-id', '--project-name', 'N', '--port', 'abc'], /--port is invalid/],
    [['--project-id', 'ok-id', '--project-name', 'N', '--port', '0'], /--port is invalid/],
    [['--project-id', 'Bad_ID', '--project-name', 'N'], /--project-id is invalid/],
    [['--project-id', 'ok-id'], /--project-name is required/],
    [['--project-id', 'ok-id', '--project-name'], /--project-name needs a value/],
    [['--project-id', 'ok-id', '--project-name', 'N', '--bogus'], /unknown argument '--bogus'/],
  ]) {
    result = bare.node('scripts/init-instance.mjs', [...args, '--root', join(bare.root, 'never')]);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, pattern, args.join(' '));
  }
  assert.ok(!existsSync(join(bare.root, 'never')), 'a rejected init must not create the folder');

  // ---- the server publishes and withdraws .tracker-url / .tracker-pid ------------------
  const fixed = await newInstance({ projectId: 'fixed-port', empty: true });
  let run = await launch(fixed, { TASK_HUB_TEST_EXIT_AFTER_MS: '1500' });
  await waitFor(() => announced(run), { message: 'the server banner' });
  assert.equal(announced(run), fixed.url, 'instance.port is used when PORT is not set');
  assert.equal(await fixed.readTrackerFile('.tracker-url'), fixed.url);
  assert.equal(await fixed.readTrackerFile('.tracker-pid'), String(run.child.pid));
  const health = await call(fixed.url, '/api/health');
  assert.equal(health.body.projectId, 'fixed-port');
  assert.equal(health.body.pid, run.child.pid);
  assert.equal(await run.exited, 0);
  assert.deepEqual((await readdir(fixed.trackerDir)).filter((name) => name.startsWith('.tracker-')), [], 'a clean exit removes both files');

  // PORT env beats instance.port
  const envPort = await getFreePort();
  run = await launch(fixed, { PORT: String(envPort), TASK_HUB_TEST_EXIT_AFTER_MS: '1200' });
  await waitFor(() => announced(run), { message: 'the server banner' });
  assert.equal(announced(run), `http://127.0.0.1:${envPort}`);
  assert.equal(await fixed.readTrackerFile('.tracker-url'), `http://127.0.0.1:${envPort}`);
  await run.exited;

  // kill -9 style: the files stay behind, and the next start simply replaces them
  run = await launch(fixed);
  await waitFor(() => announced(run), { message: 'the server banner' });
  const crashedPid = run.child.pid;
  run.child.kill();
  await run.exited;
  assert.equal(await fixed.readTrackerFile('.tracker-pid'), String(crashedPid), 'a killed server leaves stale files');
  run = await launch(fixed, { TASK_HUB_TEST_EXIT_AFTER_MS: '2500' });
  await waitFor(() => announced(run), { message: 'a restart after a hard kill' });
  assert.equal(announced(run), fixed.url);
  assert.equal(await fixed.readTrackerFile('.tracker-pid'), String(run.child.pid));

  // ---- one server per instance -------------------------------------------------------------
  const second = await launch(fixed);
  assert.equal(await second.exited, 0, 'a second launch of the same instance exits 0');
  assert.deepEqual(second.stdout.filter((line) => /already running at/.test(line)), [`Task tracker is already running at ${fixed.url}`]);
  assert.equal(await fixed.readTrackerFile('.tracker-pid'), String(run.child.pid), 'the running server keeps its files');
  assert.equal((await call(fixed.url, '/api/health')).status, 200);
  await run.exited;

  // ---- port conflicts ----------------------------------------------------------------------------
  // explicit port held by another program: refuse with a clear message
  const heldPort = await getFreePort();
  await occupy(heldPort);
  const conflicted = await newInstance({ projectId: 'conflict-game', port: heldPort });
  run = await launch(conflicted);
  assert.equal(await run.exited, 1);
  assert.match(run.stderr.join('\n'), new RegExp(`port ${heldPort} is already in use by another program\\. Choose a free port with "instance\\.port"`));
  // explicit port held by another project's tracker: name it
  const owner = await newInstance({ projectId: 'port-owner' });
  const ownerRun = await launch(owner);
  await waitFor(() => announced(ownerRun), { message: 'the owner banner' });
  const intruder = await newInstance({ projectId: 'port-intruder', port: owner.port });
  run = await launch(intruder);
  assert.equal(await run.exited, 1);
  assert.match(run.stderr.join('\n'), /already in use by the tracker for project 'port-owner'/);
  ownerRun.child.kill();
  await ownerRun.exited;

  // invalid configured port
  const invalid = await newInstance({ projectId: 'invalid-port' });
  const invalidConfigPath = join(invalid.root, 'task-hub.config.json');
  const invalidConfig = JSON.parse(readFileSync(invalidConfigPath, 'utf8'));
  invalidConfig.instance.port = 'seventy';
  await writeFile(invalidConfigPath, JSON.stringify(invalidConfig));
  run = await launch(invalid);
  assert.equal(await run.exited, 1);
  assert.match(run.stderr.join('\n'), /task-hub: instance\.port in task-hub\.config\.json must be an integer port/);

  // derived port is a preference: busy -> next free one in range (no instance.port, no PORT)
  const derivedInstance = await newInstance({ projectId: 'derived-fallback' });
  const derivedConfigPath = join(derivedInstance.root, 'task-hub.config.json');
  const derivedConfig = JSON.parse(readFileSync(derivedConfigPath, 'utf8'));
  delete derivedConfig.instance.port;
  await writeFile(derivedConfigPath, JSON.stringify(derivedConfig));
  const preferred = derivePort('derived-fallback');
  await occupy(preferred).catch(() => { /* already busy on this machine: that is the scenario */ });
  run = await launch(derivedInstance, { TASK_HUB_TEST_EXIT_AFTER_MS: '1500' });
  await waitFor(() => announced(run), { message: 'the derived-port banner' });
  const actual = Number(new URL(announced(run)).port);
  assert.notEqual(actual, preferred, 'the busy preferred port is skipped');
  assert.ok(actual >= 4300 && actual <= 4999);
  await run.exited;

  // ---- start.mjs ------------------------------------------------------------------------------------
  const started = await newInstance({ projectId: 'start-script' });
  let first = started.node('scripts/start.mjs', ['--detach']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `${started.url}\n`, 'detach prints exactly the URL');
  const pid = Number(await started.readTrackerFile('.tracker-pid'));
  assert.ok(pid > 0 && pid !== first.pid);
  const alive = await call(started.url, '/api/health');
  assert.equal(alive.body.ok, true, 'the detached server survives start.mjs exiting');
  assert.equal(alive.body.pid, pid);
  assert.ok(existsSync(join(started.trackerDir, 'server.log')), 'detached output goes to tracker/server.log');
  assert.match(await started.readTrackerFile('server.log'), /Task tracker is available at/);

  const again = started.node('scripts/start.mjs', ['--detach']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout, `${started.url}\n`, 'starting twice prints the same URL');
  assert.equal(Number(await started.readTrackerFile('.tracker-pid')), pid, 'and does not replace the running server');

  // hard kill, then --detach recovers from the stale files
  process.kill(pid);
  await waitFor(async () => !(await fetch(`${started.url}/api/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)), { message: 'the killed server to go away' });
  assert.equal(await started.readTrackerFile('.tracker-pid'), String(pid), 'stale pid file after a hard kill');
  const restarted = started.node('scripts/start.mjs', ['--detach']);
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(restarted.stdout, `${started.url}\n`);
  assert.notEqual(Number(await started.readTrackerFile('.tracker-pid')), pid);
  await started.stopServer();

  result = started.node('scripts/start.mjs', ['--nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /start: unknown argument '--nope'/);

  // detach reports a server that cannot start (its port is held by another program)
  const blockedPort = await getFreePort();
  const blocked = await newInstance({ projectId: 'detach-fail', port: blockedPort });
  await occupy(blockedPort);
  result = blocked.node('scripts/start.mjs', ['--detach']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /start: the server exited with code 1 - .*already in use by another program/);

  // foreground: first stdout line is the URL, then the server's own output
  const foreground = await newInstance({ projectId: 'foreground-start' });
  const fg = spawn(process.execPath, [join(foreground.root, 'scripts', 'start.mjs')], { cwd: foreground.root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(fg);
  const fgLines = [];
  createInterface({ input: fg.stdout }).on('line', (line) => fgLines.push(line));
  await waitFor(() => fgLines.length >= 3, { message: 'foreground output' });
  assert.equal(fgLines[0], foreground.url, 'the first line is the bare URL');
  assert.equal(fgLines[1], `Task tracker is available at ${foreground.url}`);
  assert.equal((await call(foreground.url, '/api/health')).status, 200);
  fg.kill();
  await once(fg, 'exit');
  await foreground.stopServer();

  console.log('start-init test passed: fixed port, tracker/.tracker-url+.tracker-pid lifecycle, single instance, port conflicts, start --detach, init --empty/--port.');
}, async () => {
  for (const child of children) { try { child.kill(); } catch { /* gone */ } }
  for (const dummy of dummyServers) dummy.close();
  for (const instance of instances) await instance.dispose();
});

