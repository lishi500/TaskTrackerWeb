#!/usr/bin/env node
// tt - command-line client for the Game Task Hub (TaskTrackerWeb).
// Zero dependencies, Node >= 22. Lives inside the skill so the skill is self-contained: the skill
// may be a plain copy inside a game, and the tracker instance is found without any link (see
// "Where is the tracker instance?" below; `tt doctor` prints which place won).
//
// What it hides from the agent: server URL discovery and start-up, the Origin and
// Content-Type headers, the global trackerRevision (re-read before every write, retried
// on stale/locked/EPERM), identity fields, UTF-8 and shell quoting, run ids, artifact
// naming, claim-then-decide for reviews. Run `tt help` for the command list.
//
// Environment: TT_AGENT (implementer name, default "claude"), TT_REVIEWER (fixed reviewer
// name), TT_URL (explicit server URL), TT_DIR (explicit tracker instance folder).

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTaskSet, planImport } from './taskset.mjs';

const TT_VERSION = '1.5.0'; // must equal server.mjs toolVersion (test-tt.mjs checks)
const AGENT = (process.env.TT_AGENT || 'claude').trim();
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

// ---- Output, errors, exit ------------------------------------------------------
class Exit extends Error {
  constructor(code) { super(`exit ${code}`); this.code = code; }
}

let jsonMode = false;
const emit = (lines, data) => {
  if (jsonMode) console.log(JSON.stringify(data ?? { text: lines }));
  else for (const line of [].concat(lines)) console.log(line);
};

// tt: <what failed> - <why> - try: <next command>   (stderr, exit 1)
function fail(what, why, next, details = []) {
  console.error(`tt: ${what}${why ? ` - ${why}` : ''}${next ? ` - try: ${next}` : ''}`);
  for (const line of details) console.error(`  ${line}`);
  throw new Exit(1);
}

const clip = (text, length) => {
  const characters = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return characters.length > length ? `${characters.slice(0, length - 1).join('')}…` : characters.join('');
};
const normalizeName = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

// ---- Instance and server discovery -----------------------------------------------
function derivePort(projectId) { // identical to scripts/lib/hub-port.mjs (test-start-init.mjs checks)
  const digest = createHash('sha256').update(String(projectId).trim().toLowerCase()).digest();
  return 4300 + (digest.readUInt32BE(0) % 700);
}

// Where is the tracker instance? The skill may be a COPY inside a game (no link anywhere), so tt tries,
// in this order, and the first place that names a valid instance (server.mjs + task-hub.config.json) wins:
//   1. env TT_DIR                      (an explicit value that is wrong is an error, not a hint)
//   2. tracker.json                    beside the skill's scripts/ folder: {"dir": "<absolute path>"}
//   3. .tt-dir                         one line, an absolute path, in the nearest folder above the current
//                                      directory that has AGENTS.md or .git (then in the outer ones)
//   4. sibling <folder name>-Tracker   next to that same folder
//   5. the real path of this file      is inside an instance (<instance>/.agents/skills/game-task-hub/scripts)
// `tt doctor` prints which step won and why the earlier ones did not. Pointer files must hold ABSOLUTE
// paths: a relative one would let a cloned repository steer tt at scripts it ships itself.
const DISCOVERY_STEPS = ['TT_DIR', 'tracker.json', '.tt-dir', 'sibling -Tracker folder', 'location of tt.mjs'];
const isInstanceDir = (dir) => existsSync(join(dir, 'server.mjs')) && existsSync(join(dir, 'task-hub.config.json'));
const NOT_AN_INSTANCE = 'which has no server.mjs and task-hub.config.json';

function pointerTarget(value, source) {
  const text = String(value ?? '').trim();
  if (!text) return { reason: `${source} is empty` };
  if (!isAbsolute(text)) return { reason: `${source} holds the relative path '${clip(text, 80)}'; write the absolute path of the tracker folder` };
  const dir = resolve(text);
  return isInstanceDir(dir) ? { dir } : { reason: `${source} points to ${dir}, ${NOT_AN_INSTANCE}` };
}

// Folders above (and including) `start` that have AGENTS.md or .git, nearest first.
function projectRootsFrom(start) {
  const roots = [];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'AGENTS.md')) || existsSync(join(dir, '.git'))) roots.push(dir);
    if (dirname(dir) === dir) return roots;
  }
}

function discover() {
  const trail = [];
  const note = (step, status, detail, root) => { trail.push({ step, name: DISCOVERY_STEPS[step - 1], status, detail, ...(root ? { root } : {}) }); return root ? { root, trail } : undefined; };
  const stripBom = (text) => text.replace(/^﻿/, '');
  const scriptPath = fileURLToPath(import.meta.url);

  if (process.env.TT_DIR) {
    const dir = resolve(process.env.TT_DIR);
    if (isInstanceDir(dir)) return note(1, 'won', `TT_DIR=${dir}`, dir);
    note(1, 'failed', `TT_DIR=${dir} ${NOT_AN_INSTANCE}`);
    return { trail, fatal: true };
  }
  note(1, 'skipped', 'TT_DIR is not set');

  const pointerFile = join(dirname(dirname(scriptPath)), 'tracker.json');
  if (existsSync(pointerFile)) {
    let target;
    try { target = pointerTarget(JSON.parse(stripBom(readFileSync(pointerFile, 'utf8'))).dir, pointerFile); } catch (error) { target = { reason: `${pointerFile} is not valid JSON (${error.message})` }; }
    if (target.dir) return note(2, 'won', pointerFile, target.dir);
    note(2, 'failed', target.reason);
  } else {
    note(2, 'skipped', `no tracker.json beside ${join(dirname(dirname(scriptPath)), 'scripts')}`);
  }

  const roots = projectRootsFrom(process.cwd());
  if (!roots.length) {
    note(3, 'skipped', `no folder with AGENTS.md or .git at or above ${process.cwd()}`);
    note(4, 'skipped', 'no project folder to look next to');
  } else {
    const problems = [];
    for (const root of roots) {
      const file = join(root, '.tt-dir');
      if (!existsSync(file)) continue;
      const firstLine = stripBom(readText(file)).split(/\r?\n/).find((line) => line.trim()) ?? '';
      const target = pointerTarget(firstLine, file);
      if (target.dir) return note(3, 'won', file, target.dir);
      problems.push(target.reason);
    }
    note(3, problems.length ? 'failed' : 'skipped', problems.join('; ') || `no .tt-dir in ${roots.join(', ')}`);
    for (const root of roots) {
      if (!basename(root)) continue;
      const sibling = join(dirname(root), `${basename(root)}-Tracker`);
      if (isInstanceDir(sibling)) return note(4, 'won', `${sibling} next to ${root}`, sibling);
    }
    note(4, 'skipped', `no ${roots.map((root) => `${basename(root)}-Tracker`).join(' / ')} next to ${roots.length > 1 ? 'those folders' : roots[0]}`);
  }

  const here = realpathSync(scriptPath); // follows a junction or symlink to the instance's skill
  const inside = resolve(dirname(here), '..', '..', '..', '..');
  if (isInstanceDir(inside)) return note(5, 'won', `${here} is inside it`, inside);
  note(5, 'skipped', `${here} is not inside a tracker instance`);
  return { trail };
}

let located;
function instance() {
  if (located) return located;
  const found = discover();
  if (!found.root) {
    const detail = found.trail.map(({ step, name, detail: text }) => `${step}. ${name}: ${text}`);
    fail('cannot find the tracker instance', found.fatal ? found.trail[0].detail : 'none of the 5 places names one', found.fatal ? 'fix or unset TT_DIR' : 'write the absolute path of the <Game>-Tracker folder into <game>/.tt-dir (gd-skill activate --tracker DIR does), or set TT_DIR', detail);
  }
  const root = found.root;
  const config = JSON.parse(readFileSync(join(root, 'task-hub.config.json'), 'utf8').replace(/^﻿/, ''));
  const trackerDir = dirname(resolve(root, config.instance?.tracker ?? 'tracker/task_tracker.csv'));
  const port = config.instance?.port ?? derivePort(config.instance?.projectId || 'uninitialized');
  located = { root, config, trackerDir, projectId: config.instance?.projectId ?? '', port, urlFile: join(trackerDir, '.tracker-url'), pidFile: join(trackerDir, '.tracker-pid'), discovery: found.trail };
  return located;
}

const readText = (path) => { try { return readFileSync(path, 'utf8').trim(); } catch { return ''; } };
const isLoopbackUrl = (text) => /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(text);
const normalizeUrl = (text) => String(text).trim().replace(/\/+$/, '').replace('//localhost', '//127.0.0.1'); // Node resolves localhost to ::1 first; the Hub accepts either

async function probe(url) {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    return body?.tool === 'task-hub' ? body : undefined;
  } catch {
    return undefined;
  }
}

let server; // { url, health }

async function findServer() {
  const where = instance();
  const candidates = process.env.TT_URL ? [normalizeUrl(process.env.TT_URL)] : [];
  if (!candidates.length) {
    const recorded = readText(where.urlFile);
    if (isLoopbackUrl(recorded)) candidates.push(recorded);
    candidates.push(`http://127.0.0.1:${where.port}`);
  }
  for (const url of [...new Set(candidates)]) {
    const health = await probe(url);
    if (health && (process.env.TT_URL || health.projectId === where.projectId)) return { url, health };
  }
  return undefined;
}

function startDetached() {
  const where = instance();
  const result = spawnSync(process.execPath, [join(where.root, 'scripts', 'start.mjs'), '--detach'], { cwd: where.root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.status !== 0) {
    fail('cannot start the tracker server', clip(result.stderr || result.stdout || result.error?.message || 'no output', 400), 'node scripts/start.mjs (foreground shows the error), then tt doctor');
  }
  return result.stdout.trim().split(/\r?\n/)[0];
}

async function ensureUp() {
  if (server) return server;
  let found = await findServer();
  if (!found) {
    if (process.env.TT_URL) fail(`the server at TT_URL (${process.env.TT_URL}) does not answer`, 'tt does not start a server for an explicit URL', 'unset TT_URL, or start that server');
    const url = startDetached();
    found = { url, health: await probe(url) };
    if (!found.health) fail('the server was started but does not answer', url, 'tt doctor');
  }
  if (found.health.toolVersion !== TT_VERSION) {
    console.error(`tt: warning - server is v${found.health.toolVersion}, tt is v${TT_VERSION} - try: node scripts/sync-template.mjs --target <this tracker> --apply`);
  }
  server = found;
  return server;
}

// ---- HTTP -------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code ?? '';
    this.body = body;
  }
}

async function http(method, path, body) {
  const { url } = await ensureUp();
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', Origin: url },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`cannot reach the server at ${url}`, error.cause?.code ?? error.message, 'tt up');
  }
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text || `HTTP ${response.status}` }; }
  return { status: response.status, json };
}

async function get(path) {
  const { status, json } = await http('GET', path);
  if (status >= 400) throw new ApiError(status, json);
  return json;
}

const isTransient = ({ status, json }) => (status === 409 && ['revision-stale', 'locked'].includes(json?.code))
  || (status === 500 && /EPERM|EBUSY|EACCES/.test(json?.error ?? ''));

// POST with the current trackerRevision. The revision is re-read before every
// attempt; a stale revision, a busy lock or a Windows EPERM/EBUSY on the file
// replace is retried (6 attempts, backoff). Any other 4xx is final.
async function write(path, body, { revision = true } = {}) {
  let last;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let payload = body;
    if (revision) {
      const health = await get('/api/health');
      if (!health.trackerRevision) fail('the tracker is not usable', health.trackerError || 'no revision available', 'tt doctor');
      payload = { trackerRevision: health.trackerRevision, ...body };
    }
    last = await http('POST', path, payload);
    if (last.status < 400) return last.json;
    if (!isTransient(last)) break;
    await sleep(80 * 2 ** attempt + Math.floor(Math.random() * 40));
  }
  throw new ApiError(last.status, last.json);
}

// Map a server rejection to the next command worth trying.
function hintFor(error, context) {
  const message = error.message;
  const id = context.id;
  let match;
  if (error.code === 'tracker-missing') return 'node scripts/init-instance.mjs --project-id ID --project-name "Name" --empty';
  if ((match = /Serial lane is occupied by ([A-Za-z0-9._-]+)/.exec(message))) return `tt show ${match[1]} (finish or review it first; tt next says how)`;
  if ((match = /Only Ready tasks can start a managed Run\. \S+ is '([^']+)'/.exec(message))) {
    return { Backlog: `tt admit ${id}`, Blocked: `tt unblock ${id}`, 'In Progress': `tt done ${id}`, 'In Review': `tt review ${id} approve "notes"` }[match[1]] ?? `tt show ${id}`;
  }
  if (error.code === 'reviewer-not-independent') return `tt review ${id} <approve|reject|block> "notes" --as <a different name>`;
  if (error.code === 'run-evidence-missing') return `run the project check so reports/last-check.md contains "RESULT: PASS", then tt done ${id} "summary" (or --outcome incomplete)`;
  if (error.code === 'run-evidence-failed') return `fix the failure, then close this Run as blocked (tt done ${id} "check failed" --outcome blocked --blocker "..."), tt unblock ${id}, tt start ${id} for a fresh Run`;
  if (/has not claimed/.test(message)) return `tt show ${id}`;
  if (/was not found/.test(message) && !/Run|Artifact/.test(message)) return 'tt ls';
  if (error.code === 'unknown-dependency' || error.code === 'invalid-dependency') return 'tt ls (ids are listed in the first column)';
  if (error.code === 'invalid-id') return 'use letters, digits and hyphens, for example T-001';
  if (/no longer active|already has an active managed Run/.test(message)) return id ? `tt show ${id}` : 'tt status';
  if (/already exists for Run/.test(message)) return 'use another artifact name';
  if (/unfinished dependencies/.test(message)) return id ? `tt show ${id}` : 'tt ls';
  if (error.code === 'locked') return 'wait a moment and retry; tt doctor reports stale locks';
  return id ? `tt show ${id}` : 'tt status';
}

async function guarded(action, context, work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ApiError) {
      fail(`${typeof action === 'function' ? action() : action} failed`, `HTTP ${error.status}: ${clip(error.message, 320)}`, hintFor(error, context).trim());
    }
    throw error;
  }
}

// ---- Argument parsing -------------------------------------------------------------
const VALUE_FLAGS = new Set(['profile', 'scope', 'expect', 'outcome', 'blocker', 'owner-status', 'run', 'as', 'key', 'toolchain', 'op', 'detail', 'type', 'parent', 'deps', 'accept', 'spec', 'auth', 'prio', 'milestone', 'stream', 'status', 'limit', 'reason', 'evidence', 'name']);
const BOOLEAN_FLAGS = new Set(['json', 'brief', 'dry-run', 'admit-first', 'no-evidence', 'help', 'version']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-h') { flags.help = true; continue; }
    if (!argument.startsWith('--') || argument === '--') { positional.push(argument); continue; }
    const [name, inline] = argument.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.has(name)) { flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) fail(`unknown option --${name}`, 'not a tt option', 'tt help');
    const value = inline ?? argv[++index];
    if (value === undefined) fail(`--${name} needs a value`, 'it was the last argument', 'tt help');
    if (name === 'evidence') (flags.evidence ??= []).push(value);
    else flags[name] = value;
  }
  return { positional, flags };
}

// "@file.md" reads the text from a file (handy where shell quoting of long text is fragile);
// a leading "@" that is not an existing file stays literal.
function textArg(value) {
  if (typeof value === 'string' && value.startsWith('@') && value.length > 1 && existsSync(value.slice(1)) && statSync(value.slice(1)).isFile()) {
    return readFileSync(value.slice(1), 'utf8').replace(/^\uFEFF/, '').trim();
  }
  return value;
}

const needArgs = (command, positional, count, usage) => {
  if (positional.length < count) fail(`${command} needs ${usage}`, `got ${positional.length} argument(s)`, `tt ${command} ${usage}`);
};

// ---- Shared reads --------------------------------------------------------------------
async function packetOf(id) {
  const result = await get(`/api/tasks/${encodeURIComponent(id)}/packet`);
  return { task: result.task, packet: result.packet, runs: result.packet.existingRuns ?? [], revision: result.trackerRevision };
}

const activeRunOf = (runs) => [...runs].reverse().find((run) => run.status === 'In Progress');
const isRunId = (value, id) => typeof value === 'string' && value.startsWith(`${id}-R`) && /-R\d+$/.test(value);

// Git position, best effort. The one independent reviewer of a Story needs to know which commits
// its Runs span, so `tt start` records the working directory's HEAD as the Run event
// "GITREV base=<sha>" and `tt done` records "GITREV head=<sha> dirty=<bool>". Outside a git
// repository, without git, or when the event is refused, nothing happens and nothing fails.
function gitPosition() {
  const git = (...args) => spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8', timeout: 5000, windowsHide: true });
  const head = git('rev-parse', 'HEAD');
  const sha = head.status === 0 ? head.stdout.trim() : '';
  if (!/^[0-9a-f]{7,64}$/.test(sha)) return undefined;
  const status = git('status', '--porcelain');
  return { sha, dirty: status.status !== 0 || status.stdout.trim() !== '' }; // unknown counts as dirty
}

async function recordGit(taskId, runId, kind) {
  const position = gitPosition();
  if (!position) return undefined;
  try {
    await write(`/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/events`, {
      type: 'GITREV', result: 'ok', message: kind === 'base' ? `base=${position.sha}` : `head=${position.sha} dirty=${position.dirty}`,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return undefined;
  }
  return position;
}

async function nextLine() {
  const result = await get('/api/next');
  return result.next
    ? `next: ${result.next.taskId} ${result.next.taskType} ${result.next.priority} ${result.next.status} "${clip(result.next.title, 60)}" - tt start ${result.next.taskId}`
    : '';
}

// ---- Commands -------------------------------------------------------------------------
const commands = {};

commands.up = async () => {
  const { url, health } = await ensureUp();
  emit(url, { url, projectId: health.projectId, toolVersion: health.toolVersion, pid: health.pid });
};

commands.url = async () => {
  const found = await findServer();
  if (!found) fail('the server is not running', 'there is no URL to print', 'tt up');
  emit(found.url, { url: found.url });
};

commands.down = async () => {
  const where = instance();
  const found = await findServer();
  const pid = Number(readText(where.pidFile));
  if (!found) {
    for (const file of [where.urlFile, where.pidFile]) { try { unlinkSync(file); } catch { /* none */ } }
    emit('not running', { running: false });
    return;
  }
  if (!pid || found.health.pid !== pid) fail('refusing to stop the server', `the pid file (${pid || 'empty'}) does not match the running server (${found.health.pid})`, 'stop it from the terminal that started it');
  process.kill(pid);
  for (let attempt = 0; attempt < 50 && await probe(found.url); attempt += 1) await sleep(100);
  for (const file of [where.urlFile, where.pidFile]) { try { unlinkSync(file); } catch { /* already removed by a clean exit */ } }
  emit(`stopped (pid ${pid})`, { running: false, pid });
};

commands.status = async ({ flags }) => {
  const { health } = await ensureUp();
  const list = await get('/api/tasks?limit=2000');
  const next = await get('/api/next');
  const counts = {};
  for (const task of list.tasks.filter(({ taskType }) => taskType !== 'Story')) counts[task.status] = (counts[task.status] ?? 0) + 1;
  const stories = list.tasks.length - Object.values(counts).reduce((sum, value) => sum + value, 0);
  const summary = Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(' | ') || 'no tasks';
  const nextText = next.next ? `${next.next.taskId} ${clip(next.next.title, 50)}` : `none - ${clip(next.reason, 160)}`;
  if (flags.brief) {
    emit(`${health.projectName}: ${summary}; next: ${nextText}`, { project: health.projectId, counts, next: next.next });
    return;
  }
  const lines = [`${health.projectName} (${health.projectId})  ${(await ensureUp()).url}  rev ${String(health.trackerRevision).slice(0, 8)}  lane ${health.serialLane ? 'serial' : 'open'}`, `${summary}${stories ? `   (${stories} stories)` : ''}`];
  const lane = list.tasks.filter((task) => ['In Progress', 'In Review'].includes(task.status));
  if (lane.length) lines.push(`active: ${lane.map((task) => `${task.taskId} ${task.status}${task.activeRun ? ` (${task.activeRun})` : ''}`).join(', ')}`);
  const waiting = list.tasks.filter((task) => ['Awaiting Owner', 'Awaiting Owner Gate', 'Awaiting Agent Evaluation'].includes(task.status));
  if (waiting.length) lines.push(`owner: ${waiting.map((task) => `${task.taskId} ${task.status}`).join(', ')}`);
  lines.push(`next: ${nextText}`);
  emit(lines, { health, counts, next: next.next, reason: next.reason });
};

commands.ls = async ({ flags }) => {
  const query = new URLSearchParams();
  for (const [flag, parameter] of [['status', 'status'], ['milestone', 'milestone'], ['type', 'type'], ['parent', 'parent'], ['limit', 'limit']]) if (flags[flag]) query.set(parameter, flags[flag]);
  const result = await guarded('ls', {}, () => get(`/api/tasks${query.size ? `?${query}` : ''}`));
  const lines = result.tasks.map((task) => [task.taskId, task.taskType, task.status, task.dependsOn || '-', clip(task.title, 70)].join('\t'));
  if (result.truncated) lines.push(`... ${result.total - result.count} more (use --limit or a filter)`);
  if (!lines.length) lines.push('(no tasks match)');
  emit(lines, result);
};

const AUTHORITY_WORD = { IndependentReviewerAgent: 'reviewer', RunEvidence: 'checks', DecisionOwner: 'owner', NotApplicable: '-' };

// Story lines for the one independent reviewer: the integration review state, every child with its
// authority, latest Run, artifact names and auto-accepted flag, and the git range the Runs recorded.
function storyLines(packet) {
  const { children = [], review, gitRange } = packet.context;
  const lines = [];
  if (review) {
    const checksDone = children.filter((child) => child.completionAuthority === 'RunEvidence' && child.status === 'Done').length;
    lines.push(review.state === 'gap' ? `review: GAP - ${review.message}`
      : review.state === 'complete' ? `review: complete (${review.integrationTaskId} is Done)`
        : `review: open - integration task ${review.integrationTaskId} is ${review.integrationStatus}; checks Done ${checksDone}/${review.checks.length}`);
  }
  lines.push('children:');
  for (const child of children) {
    const run = (child.runs ?? []).at(-1);
    const names = run?.artifacts ?? [];
    const shown = names.length > 3 ? `${names.slice(0, 3).join(',')},+${names.length - 3}` : names.join(',');
    lines.push(`  ${child.taskId}  ${child.status}  ${AUTHORITY_WORD[child.completionAuthority] ?? child.completionAuthority}  ${run ? `${run.runId}  ${shown || 'no artifacts'}${run.autoAccepted ? '  auto-accepted' : ''}` : 'no Run'}`);
  }
  if (!children.length) lines.push('  (none)');
  const short = (entry) => entry.sha.slice(0, 12);
  if (gitRange?.base && gitRange?.head) lines.push(`diff range ${short(gitRange.base)}..${short(gitRange.head)}${gitRange.head.dirty ? '   (the last tt done had uncommitted changes)' : ''}`);
  else if (gitRange?.base) lines.push(`diff range ${short(gitRange.base)}..?   (no finished Run recorded a head yet)`);
  else lines.push('diff range: not recorded (tt records it from a git repository when a task starts and finishes)');
  if (review?.state === 'open' && review.integrationStatus === 'In Review') {
    lines.push(`inspect: tt evidence ID [--name NAME]; decide: tt review ${review.integrationTaskId} approve|reject|block "notes" --as NAME`);
  }
  return lines;
}

commands.show = async ({ positional }) => {
  needArgs('show', positional, 1, 'ID');
  const [id] = positional;
  const result = await guarded(`show ${id}`, { id }, () => packetOf(id));
  const { task, packet, runs } = result;
  const lines = [`${task.TaskID}  ${task.TaskType}  ${task.Status}  ${task.Priority}  [${task.CompletionAuthority}]`, `title: ${clip(task.Task, 200)}`];
  lines.push(`milestone: ${task.Milestone}${task.ParentID ? `   parent: ${task.ParentID}` : ''}${task.Implementer ? `   implementer: ${task.Implementer}` : ''}${task.ReviewClaim ? `   review: ${clip(task.ReviewClaim, 80)}` : ''}`);
  lines.push(`acceptance: ${clip(task.Acceptance, 600)}`, `spec: ${clip(task.SpecRef, 200)}`);
  if (task.Blocker) lines.push(`blocker: ${clip(task.Blocker, 300)}`);
  lines.push(`deps: ${packet.dependencies.map((dependency) => `${dependency.taskId}=${dependency.status ?? 'MISSING'}`).join(', ') || '-'}`);
  if (packet.reverseDependencies.length) lines.push(`needed by: ${packet.reverseDependencies.slice(0, 12).map((dependent) => `${dependent.taskId}=${dependent.status}`).join(', ')}`);
  const isStory = task.TaskType === 'Story';
  if (isStory) lines.push(...storyLines(packet));
  else lines.push(`runs: ${runs.map((run) => `${run.runId}=${run.status}(${run.agent})`).join(', ') || '-'}`);
  if (packet.context.story) lines.push(`story: ${packet.context.story.taskId} ${clip(packet.context.story.goal, 80)} | ${clip(packet.context.story.acceptance, 200)}`);
  const evidence = String(task.Evidence ?? '').split('\n').filter(Boolean).slice(-3);
  if (evidence.length) lines.push('evidence (last 3):', ...evidence.map((line) => `  ${clip(line, 200)}`));
  emit(lines.slice(0, isStory ? 80 : 40), { task, packet });
};

// tt evidence ID [--run RUN] [--name NAME]: read one artifact (default: the passing check of the latest
// Run that has artifacts), cut at 8 KB so a review never floods the agent's context.
const MAX_EVIDENCE_BYTES = 8192;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xFFFD);

commands.evidence = async ({ positional, flags }) => {
  needArgs('evidence', positional, 1, 'ID [--run RUN] [--name NAME]');
  const [id] = positional;
  await guarded(`evidence ${id}`, { id }, async () => {
    const { task } = await packetOf(id);
    if (task.TaskType === 'Story') fail(`${id} is a Story`, 'evidence belongs to the Runs of its tasks', `tt show ${id} lists them; then tt evidence <task id>`);
    const { runs } = await get(`/api/tasks/${encodeURIComponent(id)}/runs`);
    const run = flags.run ? runs.find((candidate) => candidate.runId === flags.run) : [...runs].reverse().find((candidate) => candidate.artifacts?.length);
    if (!run) fail(flags.run ? `${id} has no Run ${flags.run}` : `${id} has no evidence`, flags.run ? `its Runs: ${runs.map((candidate) => candidate.runId).join(', ') || 'none'}` : 'no Run holds an artifact', `tt show ${id}`);
    const names = (run.artifacts ?? []).map((artifact) => artifact.name);
    if (!names.length) fail(`${run.runId} has no artifacts`, 'nothing was attached to it', `tt show ${id}`);
    let accepted;
    for (const line of String(task.Evidence ?? '').split('\n')) {
      const match = /^auto-accepted: RunEvidence \(([^,()]+), artifact (.+)\)$/.exec(line);
      if (match?.[1] === run.runId) accepted = match[2];
    }
    const name = flags.name ?? (names.includes(accepted) ? accepted : names.includes('last-check.md') ? 'last-check.md' : names[0]);
    if (!names.includes(name)) fail(`${run.runId} has no artifact '${clip(name, 60)}'`, `it has: ${names.join(', ')}`, `tt evidence ${id} --name ${names[0]}`);
    const base = (await ensureUp()).url;
    const response = await fetch(`${base}/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}/artifacts/${name.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail(`cannot read ${name}`, `HTTP ${response.status}`, `tt show ${id}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    let text = bytes.subarray(0, MAX_EVIDENCE_BYTES).toString('utf8');
    if (bytes.length > MAX_EVIDENCE_BYTES && text.endsWith(REPLACEMENT_CHARACTER)) text = text.slice(0, -1); // a multi-byte character cut in half
    const truncated = bytes.length > MAX_EVIDENCE_BYTES;
    const lines = [`evidence ${id} ${run.runId} ${name} (${bytes.length} bytes${name === accepted ? ', the passing check' : ''})`, text.replace(/\s+$/, '')];
    if (truncated) lines.push(`... truncated: showing ${Buffer.byteLength(text)} of ${bytes.length} bytes; the whole file: ${join(instance().trackerDir, 'task-records', id, run.runId, 'artifacts', ...name.split('/'))}`);
    if (names.length > 1) lines.push(`artifacts of ${run.runId}: ${names.join(', ')} (tt evidence ${id} --name NAME)`);
    emit(lines, { taskId: id, runId: run.runId, name, bytes: bytes.length, truncated, text, artifacts: names });
  });
};

commands.next = async () => {
  const result = await get('/api/next');
  if (!result.next) {
    emit(`none: ${result.reason}`, result);
    return;
  }
  const { next } = result;
  emit([
    [next.taskId, next.taskType, next.priority, next.status, clip(next.title, 100)].join('\t'),
    `acceptance: ${clip(next.acceptance, 600)}`,
    `spec: ${clip(next.specRef, 200)}`,
    `then: tt start ${next.taskId}`,
  ], result);
};

commands.new = async ({ positional, flags }) => {
  needArgs('new', positional, 2, 'ID "title" --accept "..."');
  const [id] = positional;
  const title = positional.slice(1).join(' '); // an unquoted multi-word title must not be cut to its first word
  const type = flags.type ?? 'Task';
  if (!['Task', 'Bug', 'Story'].includes(type)) fail(`--type ${type} is not valid`, 'use Task, Bug or Story', `tt new ${id} "${title}" --type Task --accept "..."`);
  const accept = textArg(flags.accept);
  if (!accept) fail('--accept is required', 'the acceptance is what the reviewer judges the work against', `tt new ${id} "${title}" --accept "what can be observed when it works"`);
  const authorities = { reviewer: 'IndependentReviewerAgent', checks: 'RunEvidence', owner: 'DecisionOwner' };
  if (flags.auth && !authorities[flags.auth]) fail(`--auth ${flags.auth} is not valid`, 'use reviewer (independent review), checks (done when the project check passes) or owner (human decision)', `tt new ${id} "${title}" --auth checks --accept "..."`);
  const authority = type === 'Story' ? 'NotApplicable' : authorities[flags.auth ?? 'reviewer'];
  const parent = flags.parent ? (await guarded(`new ${id}`, { id }, () => packetOf(flags.parent))) : undefined;
  const dependsOn = (flags.deps ?? '').split(/[;,\s]+/).filter(Boolean).join(';');
  const milestone = flags.milestone ?? parent?.task.Milestone ?? 'M1';
  const result = await guarded(`new ${id}`, { id }, () => write('/api/tasks', {
    agent: AGENT,
    reason: flags.reason ?? 'created with tt new',
    newTask: {
      taskId: id,
      taskType: type,
      parentId: type === 'Story' ? '' : flags.parent ?? '',
      milestone,
      workstream: flags.stream ?? parent?.task.Workstream ?? 'General',
      task: textArg(title),
      specRef: flags.spec ?? parent?.task.SpecRef ?? `docs/tasks/${milestone.toLowerCase()}.md#${id.toLowerCase()}`,
      dependsOn,
      ownerRole: type === 'Story' ? 'Delivery lead' : authority === 'DecisionOwner' ? 'Human decision owner' : 'Implementation agent',
      priority: flags.prio ?? 'P1',
      acceptance: accept,
      completionAuthority: authority,
    },
  }));
  // The server answers a created task with warnings while its Story still lacks an integration-acceptance Task.
  emit([`created ${id} (${type}, ${result.task.Status})`, ...(result.warnings ?? []).map((warning) => `warning: ${warning}`)], result);
};

const transition = (name, path, buildBody, describe) => async ({ positional, flags }) => {
  needArgs(name, positional, name === 'block' ? 2 : 1, name === 'block' ? 'ID "what blocks it"' : 'ID');
  const [id] = positional;
  const result = await guarded(`${name} ${id}`, { id }, () => write(`/api/tasks/${encodeURIComponent(id)}/${path}`, buildBody(positional, flags)));
  emit(describe(id, result), result);
};

commands.admit = transition('admit', 'admit', (_p, flags) => ({ agent: AGENT, targetStatus: 'Ready', reason: flags.reason ?? 'admitted with tt' }), (id, result) => `${id} -> ${result.task.Status}`);
commands.park = transition('park', 'park', (_p, flags) => ({ agent: AGENT, reason: flags.reason ?? 'parked with tt' }), (id, result) => `${id} -> ${result.task.Status}`);
commands.unblock = transition('unblock', 'unblock', (_p, flags) => ({ agent: AGENT, reason: flags.reason ?? 'dependencies are done (tt unblock)' }), (id, result) => `${id} -> ${result.task.Status}`);
commands.block = transition('block', 'block', (positional, flags) => {
  const blocker = textArg(positional.slice(1).join(' '));
  return { agent: AGENT, blocker, evidence: flags.reason ?? blocker };
}, (id, result) => `${id} -> ${result.task.Status} (${clip(result.task.Blocker, 80)})`);

// start [ID]: no ID = the next claimable task (what `tt next` shows). Admits a Backlog task first,
// opens the Run with defaults taken from the task, and prints the acceptance and spec so the agent
// does not need a separate show/next call to read its contract.
commands.start = async ({ positional, flags }) => {
  let id = positional[0];
  if (!id) {
    const upcoming = await guarded('start', {}, () => get('/api/next'));
    if (!upcoming.next) fail('there is nothing to start', clip(upcoming.reason, 300), 'tt next, or tt start ID to admit a specific Backlog task');
    id = upcoming.next.taskId;
  }
  const profile = flags.profile ?? 'logic';
  await guarded(`start ${id}`, { id }, async () => {
    const { task, runs, packet } = await packetOf(id);
    const contract = [`acceptance: ${clip(task.Acceptance, 600)}`, `spec: ${clip(task.SpecRef, 200)}`];
    const active = activeRunOf(runs);
    if (task.Status === 'In Progress' && active) {
      if (normalizeName(active.agent) !== normalizeName(AGENT)) fail(`${id} is already claimed by ${active.agent}`, `run ${active.runId} is active`, `tt show ${id}`);
      emit([`${id} already in progress: run ${active.runId} (agent ${active.agent})`, ...contract], { taskId: id, runId: active.runId, resumed: true, acceptance: task.Acceptance, specRef: task.SpecRef });
      return;
    }
    let admitted = false;
    if (task.Status === 'Backlog') {
      await write(`/api/tasks/${encodeURIComponent(id)}/admit`, { agent: AGENT, targetStatus: 'Ready', reason: 'admitted by tt start' });
      admitted = true;
    }
    const result = await write('/api/runs/start', {
      taskId: id,
      agent: AGENT,
      verificationProfile: profile,
      scope: textArg(flags.scope) ?? clip(task.Task, 300),
      expectedBehavior: textArg(flags.expect) ?? clip(packet.acceptance || task.Acceptance, 3900),
    });
    const base = await recordGit(id, result.run.runId, 'base');
    const completion = task.CompletionAuthority === 'RunEvidence' ? ['completes on: a passing project check (tt done attaches reports/last-check.md with "RESULT: PASS"); no review'] : [];
    emit([`started ${id}: run ${result.run.runId}${admitted ? ' (admitted first)' : ''}, profile ${profile}, agent ${AGENT}`, ...contract, ...completion],
      { taskId: id, runId: result.run.runId, profile, admitted, acceptance: task.Acceptance, specRef: task.SpecRef, task: result.task, gitBase: base?.sha ?? null });
  });
};

commands.event = async ({ positional }) => {
  needArgs('event', positional, 4, 'ID TYPE RESULT "message"');
  const [id] = positional;
  let rest = positional.slice(1);
  let runId = isRunId(rest[0], id) ? rest.shift() : undefined;
  if (rest.length < 3) fail('event needs TYPE RESULT "message"', `got ${rest.length} of 3`, `tt event ${id} note ok "what happened"`);
  await guarded(`event ${id}`, { id }, async () => {
    runId ??= activeRunOf((await packetOf(id)).runs)?.runId;
    if (!runId) fail(`${id} has no active Run`, 'events attach to a running Run', `tt start ${id}`);
    const [type, result, ...message] = rest;
    await write(`/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/events`, { type, result, message: textArg(message.join(' ')) });
    emit(`event recorded on ${runId}`, { taskId: id, runId });
  });
};

const MAX_ARTIFACT_BYTES = 131_072;

function readArtifactText(source) {
  let buffer;
  try {
    buffer = source === '-' ? readFileSync(0) : readFileSync(source);
  } catch (error) {
    fail(`cannot read ${source}`, error.code === 'ENOENT' ? 'no such file' : error.message, 'check the path (relative to the current directory)');
  }
  if (buffer.includes(0)) fail(`${source} is not a text file`, 'artifacts are UTF-8 text', 'attach a text summary and reference the binary by its repository path');
  if (buffer.length > MAX_ARTIFACT_BYTES) fail(`${source} is ${buffer.length} bytes`, `an artifact is limited to ${MAX_ARTIFACT_BYTES} bytes (128 KB)`, 'attach the relevant excerpt (for example the failing lines) and reference the full file by path');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

async function storeArtifact(id, runId, name, content) {
  const path = `/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/artifacts`;
  try {
    await write(path, { name, content });
    return name;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409 || !/already exists/.test(error.message)) throw error;
    // Artifacts are immutable. Same content = a repeated `tt done`; different content gets a new name.
    const existing = await fetch(`${(await ensureUp()).url}${path}/${name.split('/').map(encodeURIComponent).join('/')}`).then((response) => response.text()).catch(() => undefined);
    if (existing === content) return name;
    const dot = name.lastIndexOf('.');
    const alternative = dot > 0 ? `${name.slice(0, dot)}-2${name.slice(dot)}` : `${name}-2`;
    await write(path, { name: alternative, content });
    return alternative;
  }
}

commands.art = async ({ positional }) => {
  needArgs('art', positional, 3, 'ID NAME FILE|-');
  const [id] = positional;
  const rest = positional.slice(1);
  const explicitRun = isRunId(rest[0], id) ? rest.shift() : undefined;
  if (rest.length < 2) fail('art needs NAME and FILE', 'FILE may be - to read stdin', `tt art ${id} evidence.md notes.md`);
  const [name, file] = rest;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(name) || name.includes('..')) fail(`artifact name '${clip(name, 40)}' is not valid`, 'use letters, digits, dot, underscore, hyphen or slash', `tt art ${id} evidence.md ${file}`);
  const content = readArtifactText(file);
  await guarded(`art ${id}`, { id }, async () => {
    const runId = explicitRun ?? activeRunOf((await packetOf(id)).runs)?.runId;
    if (!runId) fail(`${id} has no active Run`, 'artifacts attach to a running Run', `tt start ${id}`);
    const stored = await storeArtifact(id, runId, name, content);
    emit(`stored ${stored} on ${runId} (${Buffer.byteLength(content)} bytes)`, { taskId: id, runId, name: stored });
  });
};

// A readable, unique, server-safe artifact name for a local evidence file.
function artifactNameFor(file, taken) {
  const base = basename(file);
  let name = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100);
  if (!/[A-Za-z0-9]/.test(name.replace(/\.[^.]*$/, ''))) name = `evidence-${taken.size + 1}${/\.[A-Za-z0-9]{1,8}$/.test(base) ? base.slice(base.lastIndexOf('.')) : '.txt'}`;
  let candidate = name;
  for (let copy = 2; taken.has(candidate); copy += 1) candidate = name.replace(/(\.[^.]*)?$/, `-${copy}$1`);
  taken.add(candidate);
  return candidate;
}

// A task id looks like T-001 or BUG-7 (the importer's convention). `tt done` takes an optional id first.
const STRICT_TASK_ID = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/;
const DEFAULT_EVIDENCE_PATTERN = '^RESULT: PASS\\b';

// `tt done "summary"` without an id closes the one active Run (of this agent).
async function soleActiveTask() {
  const { tasks } = await get(`/api/tasks?${new URLSearchParams({ status: 'In Progress', limit: '50' })}`);
  const active = tasks.filter((task) => task.activeRun && task.taskType !== 'Story');
  if (!active.length) fail('there is no active Run to close', 'no task is In Progress', 'tt next, then tt start; or name the task: tt done ID "summary"');
  if (active.length === 1) return active[0].taskId;
  const agents = new Map();
  for (const task of active) agents.set(task.taskId, activeRunOf((await packetOf(task.taskId)).runs)?.agent ?? '');
  const mine = active.filter((task) => normalizeName(agents.get(task.taskId)) === normalizeName(AGENT));
  if (mine.length === 1) return mine[0].taskId;
  fail(mine.length ? `${mine.length} of your tasks are In Progress` : `no active Run belongs to agent '${AGENT}'`,
    `active: ${active.map((task) => `${task.taskId} (agent ${agents.get(task.taskId) || '?'})`).join(', ')}`, 'tt done ID "summary" (TT_AGENT names you)');
}

// A RunEvidence task closes straight to Done when its Run holds a passing check. Refuse locally,
// before anything is uploaded, what the server would refuse: a failing check (its artifact would
// poison the Run for good), or no passing marker anywhere.
async function precheckEvidence(id, run, texts) {
  const failing = texts.find(({ text }) => /^RESULT: FAIL\b/m.test(text));
  if (failing) {
    const line = failing.text.split(/\r?\n/).find((candidate) => /^RESULT: FAIL\b/.test(candidate));
    fail(`${id} cannot close as verified: ${basename(failing.file)} says "${clip(line, 120)}"`, 'a Run with a failing check is refused',
      `fix the failure and run the project check again; or tt done ${id} "why" --outcome incomplete`);
  }
  let pattern;
  try { pattern = new RegExp((await ensureUp()).health.runEvidencePattern ?? DEFAULT_EVIDENCE_PATTERN, 'm'); } catch { return; }
  if (texts.some(({ text }) => pattern.test(text))) return;
  const attached = (await get(`/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}`)).run.artifacts ?? [];
  if (!attached.length) {
    fail(`${id} cannot close as verified: no evidence file has a line matching ${pattern.source}`, 'this task completes on a passing check',
      `run the project check so reports/last-check.md contains "RESULT: PASS", or tt done ${id} "what is missing" --outcome incomplete`);
  }
}

commands.done = async ({ positional, flags }) => {
  const context = {};
  await guarded(() => `done${context.id ? ` ${context.id}` : ''}`, context, async () => {
    let id = positional[0] && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(positional[0]) ? positional[0] : undefined;
    let found;
    if (id) {
      try {
        found = await packetOf(id);
      } catch (error) {
        if (!(error instanceof ApiError) || ![400, 404].includes(error.status)) throw error;
        if (STRICT_TASK_ID.test(id)) fail(`no task '${id}'`, 'tt done takes an optional task id first; this looks like one, but the Hub does not know it', 'tt ls (write the summary as a sentence if it was one)');
        id = undefined; // not a task: the words are the summary
      }
    }
    const implicit = !id;
    const summaryArgument = (id ? positional.slice(1) : positional).join(' ');
    id ??= await soleActiveTask();
    context.id = id;
    const { task, runs } = found ?? await packetOf(id);
    if (task.Status !== 'In Progress') fail(`${id} is ${task.Status}, not In Progress`, 'only a task with an active Run can be closed', task.Status === 'Ready' || task.Status === 'Backlog' ? `tt start ${id}` : `tt show ${id}`);
    const run = flags.run ? runs.find((candidate) => candidate.runId === flags.run) : activeRunOf(runs);
    if (!run) fail(`${id} has no ${flags.run ? `Run ${flags.run}` : 'active Run'}`, 'nothing to close', `tt show ${id}`);
    if (implicit && normalizeName(run.agent) !== normalizeName(AGENT)) fail(`${id} is claimed by ${run.agent}, not by ${AGENT}`, 'tt done without an id only closes your own Run', `tt done ${id} "summary" (TT_AGENT names you)`);
    const summaryText = summaryArgument ? textArg(summaryArgument) : '';
    const outcome = flags.outcome ?? (task.CompletionAuthority === 'DecisionOwner' ? 'awaiting-human' : 'verified');
    if (!['verified', 'blocked', 'incomplete', 'awaiting-human'].includes(outcome)) fail(`--outcome ${outcome} is not valid`, 'use verified, blocked, incomplete or awaiting-human', `tt done ${id} "summary" --outcome blocked --blocker "why"`);
    if (outcome === 'blocked' && !flags.blocker) fail('a blocked Run needs --blocker', 'say what blocks it, concretely', `tt done ${id} --outcome blocked --blocker "what is missing"`);
    if (['incomplete', 'awaiting-human'].includes(outcome) && !summaryText) fail(`${outcome} needs a summary`, outcome === 'incomplete' ? 'say what is still missing' : 'say what the owner has to decide', `tt done ${id} "summary" --outcome ${outcome}`);

    // Evidence: explicit files, plus reports/last-check.md when it is newer than the Run.
    const files = [...(flags.evidence ?? [])];
    let staleCheck = false;
    if (outcome === 'verified' && !flags['no-evidence']) {
      const lastCheck = join(process.cwd(), 'reports', 'last-check.md');
      if (existsSync(lastCheck) && !files.some((file) => resolve(file) === lastCheck)) {
        if (statSync(lastCheck).mtimeMs > Date.parse(run.startedAt)) files.push(lastCheck);
        else staleCheck = true;
      }
      if (!files.length) {
        fail(`${id} cannot be closed as verified without evidence`, staleCheck ? 'reports/last-check.md is older than this Run - run the check again' : 'no --evidence file and no reports/last-check.md', `run the project check (it writes reports/last-check.md), or tt done ${id} "summary" --evidence FILE, or --no-evidence`);
      }
    }
    const texts = files.map((file) => ({ file, text: readArtifactText(file) }));
    const completesOnChecks = task.CompletionAuthority === 'RunEvidence';
    if (completesOnChecks && outcome === 'verified' && !flags['no-evidence']) await precheckEvidence(id, run, texts);
    const taken = new Set();
    const stored = [];
    for (const { file, text } of texts) stored.push(await storeArtifact(id, run.runId, artifactNameFor(file, taken), text));
    await recordGit(id, run.runId, 'head');

    const summary = summaryText || (outcome === 'blocked' ? textArg(flags.blocker) : `Verified${stored.length ? `; evidence: ${stored.join(', ')}` : ''}.`);
    const result = await write(`/api/tasks/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}/close`, {
      outcome,
      summary,
      ...(flags.blocker ? { blocker: textArg(flags.blocker) } : {}),
      ...(outcome === 'awaiting-human' ? { ownerStatus: flags['owner-status'] ?? 'Awaiting Owner' } : {}),
    });
    const status = result.task.Status;
    const autoAccepted = completesOnChecks && outcome === 'verified' && status === 'Done';
    const lines = [`${id} -> ${status} (run ${run.runId}, ${outcome}${stored.length ? `; evidence: ${stored.join(', ')}` : ''}${autoAccepted ? '; auto-accepted' : ''})`];
    let upcoming = '';
    if (status === 'Done') {
      upcoming = await nextLine();
      if (upcoming) lines.push(upcoming);
    } else if (status === 'In Review') {
      if (task.ParentID) lines.push(`then: independent review (tt show ${task.ParentID}; tt review ${id} approve|reject|block "notes" --as NAME)`);
    }
    emit(lines, { taskId: id, runId: run.runId, status, outcome, evidence: stored, autoAccepted, next: upcoming || null });
  });
};

commands.review = async ({ positional, flags }) => {
  needArgs('review', positional, 2, 'ID approve|reject|block "notes"');
  const [id, verb] = positional;
  const decision = { approve: 'approved', approved: 'approved', reject: 'rejected', rejected: 'rejected', block: 'blocked', blocked: 'blocked' }[String(verb).toLowerCase()];
  if (!decision) fail(`'${verb}' is not a review decision`, 'use approve, reject or block', `tt review ${id} approve "what I verified"`);
  const notes = textArg(positional.slice(2).join(' '));
  if (!notes) fail('review notes are required', 'they are the audit record: say what you checked and what you found', `tt review ${id} ${verb} "what I verified"`);
  const reviewer = (flags.as || process.env.TT_REVIEWER || `reviewer-${randomBytes(2).toString('hex')}`).trim();
  await guarded(`review ${id}`, { id }, async () => {
    const { task, runs } = await packetOf(id);
    if (task.Status !== 'In Review') fail(`${id} is ${task.Status}, not In Review`, 'only a task whose Run was closed as verified can be reviewed', task.Status === 'In Progress' ? `tt done ${id}` : 'tt next');
    const implementers = [task.Implementer, ...runs.filter((run) => run.status !== 'Abandoned').map((run) => run.agent)].filter(Boolean);
    const clash = implementers.find((name) => normalizeName(name) === normalizeName(reviewer));
    if (clash) fail(`reviewer '${reviewer}' is not independent of '${clash}'`, 'a reviewer must differ from every agent that implemented the task (case and spaces are ignored)', `tt review ${id} ${verb} "..." --as <another name>`);
    const claimant = /^REVIEW-CLAIM: (.+) \d{4}-\d{2}-\d{2}T\S+$/.exec(task.ReviewClaim ?? '')?.[1];
    if (claimant && normalizeName(claimant) !== normalizeName(reviewer)) fail(`${id} is already claimed by '${claimant}'`, 'only the claiming reviewer can decide', `tt review ${id} ${verb} "..." --as "${claimant}"`);
    if (!task.ReviewClaim) await write(`/api/tasks/${encodeURIComponent(id)}/review`, { action: 'claim', reviewer });
    const result = await write(`/api/tasks/${encodeURIComponent(id)}/review`, {
      action: 'decision', reviewer, decision, notes,
      ...(decision === 'blocked' ? { blocker: flags.blocker ? textArg(flags.blocker) : clip(notes, 500) } : {}),
    });
    const lines = [`${id} -> ${result.task.Status} (${decision} by ${reviewer})`];
    const upcoming = decision === 'approved' ? await nextLine() : '';
    if (upcoming) lines.push(upcoming);
    emit(lines, { taskId: id, status: result.task.Status, decision, reviewer, next: upcoming || null });
  });
};

// Owner feedback arrived on a task (status "Awaiting Agent Evaluation"): record the agent's reading of it.
// DecisionOwner work -> /owner-evaluation; reviewer-authority work -> /owner-feedback-disposition.
commands.eval = async ({ positional, flags }) => {
  needArgs('eval', positional, 3, 'ID approve|resume|block|defer|return "notes"');
  const [id, verbArgument] = positional;
  const verb = String(verbArgument).toLowerCase();
  const notes = textArg(positional.slice(2).join(' '));
  await guarded(`eval ${id}`, { id }, async () => {
    const { task } = await packetOf(id);
    if (task.Status !== 'Awaiting Agent Evaluation') {
      fail(`${id} is ${task.Status}, not Awaiting Agent Evaluation`, 'there is no owner feedback waiting for an agent', String(task.Status).startsWith('Awaiting Owner') ? 'wait for the owner to answer in the dashboard' : `tt show ${id}`);
    }
    const ownerStatus = flags['owner-status'] ?? 'Awaiting Owner';
    const blocker = flags.blocker ? textArg(flags.blocker) : clip(notes, 500);
    let result;
    if (task.CompletionAuthority === 'DecisionOwner') {
      const decision = { approve: 'approved', block: 'blocked', defer: 'deferred', return: 'return-to-owner' }[verb];
      if (!decision) fail(`'${verbArgument}' does not fit a DecisionOwner task`, 'use approve, block, defer or return', `tt eval ${id} approve "what the owner decided"`);
      result = await write(`/api/tasks/${encodeURIComponent(id)}/owner-evaluation`, { agent: AGENT, decision, notes, ...(decision === 'blocked' ? { blocker } : {}) });
    } else {
      const action = { resume: 'resume', block: 'blocked', return: 'return-to-owner' }[verb];
      if (!action) fail(`'${verbArgument}' does not fit ${task.CompletionAuthority} work`, 'feedback cannot approve it: resume (new Run + independent review), block or return', `tt eval ${id} resume "what changes"`);
      result = await write(`/api/tasks/${encodeURIComponent(id)}/owner-feedback-disposition`, { actor: AGENT, action, reason: notes, ...(action === 'blocked' ? { blocker } : {}), ...(action === 'return-to-owner' ? { ownerStatus } : {}) });
    }
    emit(`${id} -> ${result.task.Status} (${verb})`, { taskId: id, status: result.task.Status, verb });
  });
};

commands.issue = async ({ positional, flags }) => {
  needArgs('issue', positional, 2, 'ID "summary" --key K --toolchain T --op O');
  const [id] = positional;
  for (const required of ['key', 'toolchain', 'op']) if (!flags[required]) fail(`--${required} is required`, 'a toolchain issue is aggregated by its stable failure key', `tt issue ${id} "summary" --key godot.headless.import-timeout --toolchain godot --op import`);
  await guarded(`issue ${id}`, { id }, async () => {
    const runId = activeRunOf((await packetOf(id)).runs)?.runId;
    const result = await write('/api/toolchain-issues', {
      taskId: id, ...(runId ? { runId } : {}), failureKey: flags.key, reporter: AGENT, toolchain: flags.toolchain, operation: flags.op,
      summary: textArg(positional.slice(1).join(' ')), ...(flags.detail ? { detail: textArg(flags.detail) } : {}),
    }, { revision: false });
    emit(`reported ${flags.key}: ${result.issue.totalReportCount} report(s), ${result.issue.unacknowledgedCount} unacknowledged`, result);
  });
};

commands.import = async ({ positional, flags }) => {
  needArgs('import', positional, 1, 'FILE');
  const file = positional[0];
  let source;
  try { source = readFileSync(file, 'utf8'); } catch (error) { fail(`cannot read ${file}`, error.code === 'ENOENT' ? 'no such file' : error.message, 'tt import docs/tasks/<milestone>.md'); }
  // SpecRef points at the document relative to the project root (the current directory); never store an absolute path.
  const docPath = (() => { const rel = relative(process.cwd(), resolve(file)).replaceAll('\\', '/'); return rel.startsWith('..') || /^[A-Za-z]:/.test(rel) ? basename(file) : rel; })();
  const parsed = parseTaskSet(source, { docPath });
  if (parsed.header.lane === 'prototype') {
    fail(`${file} is a prototype-lane task set`, "Lane is 'prototype': it is a checklist for work that is not tracked in the Hub", `keep it as a checklist, or change the Lane line to 'slice' if it should be tracked`);
  }
  const known = await guarded('import', {}, () => get('/api/tasks?limit=2000'));
  if (known.truncated) fail('the Hub holds more than 2000 items', 'import cannot tell which ids already exist', 'split the plan per milestone, or create the new items with tt new');
  const existing = new Map(known.tasks.map((task) => [task.taskId, task]));
  const plan = planImport(parsed, existing, { defaultMilestone: flags.milestone ?? '' });
  if (plan.errors.length) {
    const shown = plan.errors.slice(0, 12).map((problem) => `line ${problem.line}: ${problem.message}`);
    if (plan.errors.length > shown.length) shown.push(`... ${plan.errors.length - shown.length} more`);
    fail(`import ${file}`, `${plan.errors.length} problem(s), nothing was written`, 'fix the file and run tt import again (existing ids are skipped, so re-running is safe)', shown);
  }
  const count = (kind) => plan.creates.filter((item) => item.kind === kind).length;
  const tally = `${plan.creates.length} (${count('Story')} Story, ${count('Task')} Task, ${count('Bug')} Bug)`;
  if (flags['dry-run']) {
    emit([`dry-run ${file}: would create ${tally}, skip ${plan.skipped.length} existing`, ...(plan.creates.length ? [`would create: ${plan.creates.map((item) => item.id).join(' ')}`] : [])], { dryRun: true, creates: plan.creates, skipped: plan.skipped });
    return;
  }
  const created = [];
  for (const item of plan.creates) {
    try {
      await write('/api/tasks', { agent: AGENT, reason: `imported from ${docPath}`, newTask: item.payload });
      created.push(item.id);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      fail(`import stopped at ${item.id}`, `HTTP ${error.status}: ${clip(error.message, 300)}${created.length ? `; ${created.length} item(s) were created before it` : ''}`, 'fix the cause and run tt import again (existing ids are skipped)');
    }
  }
  const lines = [created.length ? `imported ${file}: created ${tally}, skipped ${plan.skipped.length} existing` : `nothing to import from ${file}: all ${plan.skipped.length} item(s) already exist (existing tasks are never modified)`];
  if (created.length) lines.push(`created: ${created.join(' ')}`);
  let admitted = '';
  if (flags['admit-first']) {
    // First runnable executable task: not a Story, not already started, dependencies Done (or none).
    const statusOf = new Map([...existing].map(([taskId, task]) => [taskId, task.status]));
    for (const item of plan.creates) statusOf.set(item.id, 'Backlog');
    const runnable = parsed.items.find((item) => item.kind !== 'Story' && statusOf.get(item.id) === 'Backlog'
      && item.depends.every((dependency) => statusOf.get(dependency) === 'Done'));
    if (!runnable) lines.push('admit-first: no runnable Backlog task (every task waits for a dependency)');
    else {
      try {
        await write(`/api/tasks/${encodeURIComponent(runnable.id)}/admit`, { agent: AGENT, targetStatus: 'Ready', reason: 'first runnable task admitted by tt import --admit-first' });
        admitted = runnable.id;
        lines.push(`admitted: ${runnable.id} (Ready) - tt start ${runnable.id}`);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        lines.push(`admit-first: ${runnable.id} was not admitted (${clip(error.message, 160)})`);
      }
    }
  }
  emit(lines, { created, skipped: plan.skipped, admitted });
};

commands.doctor = async () => {
  const lines = [];
  const note = (level, text) => lines.push(`${level.padEnd(4)} ${text}`);
  note(Number(process.versions.node.split('.')[0]) >= 22 ? 'ok' : 'FAIL', `node ${process.versions.node} (needs >= 22)`);
  // Which of the five places named the instance, and why the earlier ones did not.
  const found = discover();
  const earlier = found.root ? found.trail.slice(0, -1) : found.trail;
  if (!found.root) {
    for (const { step, name, status, detail } of earlier) note(status === 'failed' ? 'FAIL' : 'info', `step ${step} ${name}: ${detail}`);
    note('FAIL', 'no tracker instance found - write the absolute path of the <Game>-Tracker folder into <game>/.tt-dir (gd-skill activate --tracker DIR does), or set TT_DIR');
    emit(lines, { lines });
    throw new Exit(1);
  }
  const where = instance();
  const winner = found.trail.at(-1);
  note('ok', `instance ${where.root} (project ${where.projectId || '?'}, port ${where.port})`);
  note('ok', `found by step ${winner.step} ${winner.name}: ${winner.detail}`);
  for (const { step, name, status, detail } of earlier) note(status === 'failed' ? 'warn' : 'info', `step ${step} ${name}: ${detail}`);
  const wasUp = Boolean(await findServer());
  const { url, health } = await ensureUp();
  note('ok', `server ${url} v${health.toolVersion} pid ${health.pid}${wasUp ? '' : ' (was down, started now)'}`);
  note(health.ok ? 'ok' : 'FAIL', health.ok ? `tracker rev ${String(health.trackerRevision).slice(0, 8)}, dependency graph valid` : `tracker: ${clip(health.trackerError, 240)}`);
  if (health.toolVersion !== TT_VERSION) note('warn', `tt is v${TT_VERSION} but the server is v${health.toolVersion} - sync the template`);
  if (health.ok) {
    // Review once per Story: Stories whose checks Tasks no reviewer Task covers can never become Done.
    const review = (await get('/api/summary').catch(() => ({}))).storyReview ?? { gaps: [], open: [] };
    for (const gap of review.gaps) note('warn', clip(gap.message, 400));
    const waiting = review.open.filter((story) => story.integrationStatus === 'In Review');
    if (waiting.length) note('ok', `integration review waiting for a reviewer: ${waiting.map((story) => `${story.storyId} (tt review ${story.integrationTaskId} ...)`).join(', ')}`);
  }
  const recorded = readText(where.urlFile);
  if (recorded !== url) note('warn', `tracker/.tracker-url says '${recorded || 'nothing'}' but the server answers at ${url}`);
  const csvPath = join(where.trackerDir, 'task_tracker.csv');
  if (existsSync(csvPath)) {
    const head = readFileSync(csvPath).subarray(0, 4096).toString('utf8');
    if (head.charCodeAt(0) === 0xFEFF) note('warn', 'the CSV starts with a UTF-8 BOM (read fine; the next Hub write removes it)');
    if (head.includes('\r\n')) note('warn', 'the CSV has CRLF line endings (read fine; the next Hub write converts to LF)');
  }
  for (const lock of ['task_tracker.csv.lock', 'toolchain_issue_events.jsonl.lock']) {
    const lockPath = join(where.trackerDir, lock);
    if (!existsSync(lockPath)) continue;
    let holder;
    try { holder = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* legacy or half-written */ }
    const age = Math.round((Date.now() - (holder?.createdAt ? Date.parse(holder.createdAt) : statSync(lockPath).mtimeMs)) / 1000);
    note('warn', `lock ${lock} held ${age}s${holder?.pid ? ` by pid ${holder.pid}` : ''}; a dead holder or a lock older than 120 s is replaced automatically on the next write`);
  }
  if (!lines.some((line) => line.startsWith('warn') || line.startsWith('FAIL'))) note('ok', 'no problems found');
  emit(lines, { lines });
};

// ---- Dispatch ----------------------------------------------------------------------------
const HELP = `tt ${TT_VERSION} - Game Task Hub CLI   (agent: ${AGENT}; --json prints raw JSON)
  next                                      the task to work on, or why there is none
  start [ID] [--profile logic|runtime|scene|package-config|build-export] [--scope "..."] [--expect "..."]   no ID = the next claimable task; prints acceptance + spec
  event ID [RUN] TYPE RESULT "message"      optional progress note on the active Run
  art ID [RUN] NAME FILE|-                  attach text evidence (<= 128 KB)
  done [ID] ["summary"] [--evidence FILE]... [--no-evidence] [--outcome verified|blocked|incomplete|awaiting-human] [--blocker "..."] [--owner-status "Awaiting Owner Gate"]   no ID = your one active Run; a checks task goes straight to Done on RESULT: PASS
  review ID approve|reject|block "notes" [--as NAME] [--blocker "..."]
  show ID | ls [--status S] [--milestone M] [--type T] [--parent ID] [--limit N] | status [--brief]   show STORY = children, authorities, artifacts, git range
  evidence ID [--run RUN] [--name NAME]     print one artifact (cut at 8 KB)
  import FILE [--dry-run] [--admit-first] [--milestone M]
  new ID "title" --accept "..." [--type Task|Bug|Story] [--parent S] [--deps "A;B"] [--spec PATH] [--auth reviewer|checks|owner] [--prio P1] [--milestone M] [--stream X]
  admit ID | park ID | unblock ID | block ID "what blocks it" | issue ID "summary" --key K --toolchain T --op O [--detail "..."]
  eval ID approve|resume|block|defer|return "notes"   record your reading of owner feedback (task is Awaiting Agent Evaluation)
  up | down | url | doctor                  "@file.md" as a text argument reads that file`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  jsonMode = Boolean(flags.json);
  if (flags.version) { console.log(`tt ${TT_VERSION}`); return; }
  const [command, ...rest] = positional;
  if (!command || command === 'help' || flags.help) { console.log(HELP); return; }
  if (!commands[command]) fail(`unknown command '${command}'`, 'not a tt command', 'tt help');
  await commands[command]({ positional: rest, flags });
}

try {
  await main();
} catch (error) {
  if (error instanceof Exit) process.exitCode = error.code;
  else {
    console.error(`tt: internal error - ${error?.stack ?? error}`);
    process.exitCode = 1;
  }
}
