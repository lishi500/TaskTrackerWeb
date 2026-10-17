// Shared helpers for the node scripts/test-*.mjs suites (no dependencies).
// Each suite stays a standalone script (exit 0/1); this only removes the
// copy-pasted "create temp CSV, spawn server, parse its URL" boilerplate.

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const header = ['TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'CompletionAuthority', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];

// Build one CSV row (array in header order) from a few named fields.
export function taskRow(fields) {
  const values = {
    TaskType: 'Task', ParentID: '', Milestone: 'M1', Workstream: 'Test', Task: `Task ${fields.TaskID}`,
    SpecRef: 'README.md', DependsOn: '', OwnerRole: 'Agent', Status: 'Backlog', Priority: 'P1',
    Acceptance: 'Observable acceptance text.', CompletionAuthority: 'IndependentReviewerAgent',
    Blocker: '', Implementer: '', Evidence: '', Updated: '', ReviewClaim: '', Reviewer: '',
    ...fields,
  };
  return header.map((name) => values[name] ?? '');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvText(rows, { eol = '\n', bom = false } = {}) {
  return `${bom ? '\uFEFF' : ''}${[header, ...rows].map((row) => row.map(csvCell).join(',')).join(eol)}${eol}`;
}

// A throw-away instance directory under the OS temp dir. dispose() removes it;
// callers that created junctions inside must remove the links themselves first.
export async function createSandbox(prefix, rows = []) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const trackerPath = join(dir, 'task_tracker.csv');
  await mkdir(join(dir, 'task-records'), { recursive: true });
  const sandbox = {
    dir,
    trackerPath,
    async writeTracker(nextRows = rows, options) { await writeFile(trackerPath, csvText(nextRows, options), 'utf8'); },
    async dispose() { await rm(dir, { recursive: true, force: true }); },
  };
  await sandbox.writeTracker(rows);
  return sandbox;
}

// Spawn server.mjs on an OS-assigned loopback port against a temp CSV and
// wait for its announcement line. Extra env overrides defaults.
export async function startHub({ trackerPath, env = {}, cwd = repoRoot, timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd,
    env: { ...process.env, NODE_ENV: 'test', TASK_HUB_SERIAL_LANE: 'false', PORT: '0', HOST: '127.0.0.1', TRACKER_CSV: trackerPath, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => stdout.push(line));
  const url = await new Promise((resolveUrl, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for the Hub to start. stdout=${stdout.join(' | ')} stderr=${stderr.join(' | ')}`)), timeoutMs);
    lines.on('line', (line) => {
      const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
      if (match) { clearTimeout(timeout); resolveUrl(match[1]); }
    });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Hub exited early with ${code}. stdout=${stdout.join(' | ')} stderr=${stderr.join(' | ')}`)); });
  });
  return {
    url, child, stdout, stderr,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit').catch(() => {});
      }
    },
  };
}

export function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

// A case that cannot run on this OS (or machine) says so: test-all.mjs lists every "SKIP: reason" line.
export const skipNote = (reason) => console.log(`SKIP: ${reason}`);

// A whole suite that is inherently specific to another OS stops cleanly (exit 0) and says why.
export function skipSuite(reason) {
  skipNote(reason);
  process.exit(0);
}

export const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

export async function waitFor(check, { timeoutMs = 10_000, intervalMs = 50, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}.`);
    await sleep(intervalMs);
  }
}

// A real Tracker instance in a temp folder: the shipped files (server, public,
// scripts, templates, the skill) copied from this repository and initialized
// with init-instance.mjs, exactly as a game would get it. `parent` lets a test
// place it under a path with spaces and non-ASCII characters.
export async function createInstance({ parent = tmpdir(), name = 'task-tracker-instance-', exactName = false, projectId = 'test-game', projectName = 'Test Game', port, empty = true } = {}) {
  await mkdir(parent, { recursive: true });
  // exactName: the folder is called exactly `name` (for the "<game>-Tracker" sibling convention) instead of name + random suffix.
  const root = exactName ? join(parent, name) : await mkdtemp(join(parent, name));
  if (exactName) await mkdir(root);
  const skip = (source) => !/[\\/]scripts[\\/]test-[^\\/]*\.mjs$/.test(source);
  for (const entry of ['server.mjs', 'public', 'scripts', 'templates', '.agents']) await cp(join(repoRoot, entry), join(root, entry), { recursive: true, filter: skip });
  const listenPort = port ?? await getFreePort();
  const init = spawnSync(process.execPath, [join(root, 'scripts', 'init-instance.mjs'), '--project-id', projectId, '--project-name', projectName, '--port', String(listenPort), ...(empty ? ['--empty'] : [])], { cwd: root, encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`init-instance failed: ${init.stderr}`);
  const trackerDir = join(root, 'tracker');
  const instance = {
    root,
    port: listenPort,
    url: `http://127.0.0.1:${listenPort}`,
    trackerDir,
    trackerPath: join(trackerDir, 'task_tracker.csv'),
    node: (script, args = [], options = {}) => spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, encoding: 'utf8', ...options }),
    async readTrackerFile(name) { return (await readFile(join(trackerDir, name), 'utf8')).trim(); },
    // Stop whatever server this instance launched (by its pid file), then forget it.
    async stopServer() {
      try {
        const pid = Number(await instance.readTrackerFile('.tracker-pid'));
        if (pid) process.kill(pid);
      } catch { /* not running */ }
      await waitFor(async () => !(await fetch(`${instance.url}/api/health`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false)), { timeoutMs: 5_000, message: 'the server to stop' }).catch(() => {});
    },
    async dispose() {
      await instance.stopServer();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    },
  };
  return instance;
}

export const mutation = (url, payload, headers = {}) => ({
  method: 'POST',
  headers: { Origin: url, 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(payload),
});

// fetch + tolerant body parsing: { response, status, body (JSON or text), text }
export async function call(url, path, options = {}) {
  const response = await fetch(`${url}${path}`, options);
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { response, status: response.status, headers: response.headers, body, text };
}

// Run a suite body, always stop what it started, and exit non-zero on failure.
export async function runSuite(name, body, cleanup = async () => {}) {
  try {
    await body();
  } catch (error) {
    console.error(`${name} FAILED:`, error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}
