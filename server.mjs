#!/usr/bin/env node

import { createServer } from 'node:http';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const toolDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.TASK_HUB_CONFIG ?? join(toolDir, 'task-hub.config.json'));
const config = JSON.parse(await readFile(configPath, 'utf8'));
const instance = config.instance ?? {};
const trackerPath = process.env.TRACKER_CSV
  ? resolve(process.env.TRACKER_CSV)
  : instance.tracker ? resolve(toolDir, instance.tracker) : undefined;
const publicDir = join(toolDir, 'public');
const taskRecordsDir = trackerPath ? join(dirname(trackerPath), 'task-records') : undefined;
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
let activePort = port;
const ownerInputStatuses = new Set([
  'Awaiting Owner',
  'Awaiting Owner Gate',
  'Awaiting Agent Evaluation',
]);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};
const maxArtifactBytes = 131_072;
const maxArtifactBytesPerRun = 524_288;
const maxArtifactCountPerRun = 32;
// This fault hook is deliberately reachable only from the isolated Node test
// process. It exercises recovery after the CSV commit but before run finalization.
let testCloseFailureRemaining = process.env.NODE_ENV === 'test'
  && process.env.TASK_HUB_TEST_FAIL_CLOSE_AFTER_TRACKER === '1' ? 1 : 0;
let testClaimFailureRemaining = process.env.NODE_ENV === 'test'
  && process.env.TASK_HUB_TEST_FAIL_CLAIM_BEFORE_TRACKER === '1' ? 1 : 0;
const testClaimFailureTask = process.env.TASK_HUB_TEST_FAIL_CLAIM_TASK ?? '';
let testClaimAfterTrackerFailureRemaining = process.env.NODE_ENV === 'test'
  && process.env.TASK_HUB_TEST_FAIL_CLAIM_AFTER_TRACKER === '1' ? 1 : 0;
const testClaimAfterTrackerFailureTask = process.env.TASK_HUB_TEST_FAIL_CLAIM_AFTER_TRACKER_TASK ?? '';

function parseCsv(source) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (field !== '' || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((record) => record.some((value) => value !== ''));
}

function encodeCsv(rows) {
  return `${rows.map((row) => row.map((value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\n')}\n`;
}

async function readTracker() {
  if (!trackerPath) {
    const error = new Error('No tracker is configured. Add a project to task-hub.config.json or set TRACKER_CSV.');
    error.statusCode = 503;
    throw error;
  }
  const source = await readFile(trackerPath, 'utf8');
  const rows = parseCsv(source);
  const [header, ...body] = rows;
  if (!header?.includes('TaskID') || !header.includes('Status')) {
    throw new Error('task_tracker.csv must contain TaskID and Status columns.');
  }
  const taskIdIndex = header.indexOf('TaskID');
  const malformed = body
    .map((values, index) => ({ line: index + 2, taskId: values[taskIdIndex] || '<missing TaskID>', fieldCount: values.length }))
    .filter(({ fieldCount }) => fieldCount !== header.length);
  if (malformed.length) {
    const details = malformed.map(({ line, taskId, fieldCount }) => `line ${line} (${taskId}: ${fieldCount}/${header.length} fields)`).join(', ');
    const error = new Error(`Tracker CSV has inconsistent row widths: ${details}. Refusing to read or rewrite it.`);
    error.statusCode = 422;
    throw error;
  }
  const records = body.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index]])));
  return {
    header,
    records,
    trackerRevision: createHash('sha256').update(source).digest('hex'),
  };
}

async function replaceTracker(header, records) {
  if (!trackerPath) throw new Error('No tracker is configured.');
  const existing = await stat(trackerPath);
  const rows = [header, ...records.map((record) => header.map((name) => record[name] ?? ''))];
  const temporaryPath = `${trackerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, encodeCsv(rows), { encoding: 'utf8', mode: existing.mode });
    await rename(temporaryPath, trackerPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function withTrackerLock(action) {
  const lockPath = `${trackerPath}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error('Tracker is being updated by another process. Reload and try again.');
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function withRunLock(taskId, runId, action) {
  const directory = recordDirectory(taskId, runId);
  const lockPath = join(directory, '.run.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const conflict = new Error(`Run '${runId}' is being updated by another request. Reload and try again.`);
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

function summarize(records) {
  const statusCounts = Object.groupBy(records, ({ Status }) => Status || 'Unspecified');
  const ownerActions = records.filter(({ Status }) => ownerInputStatuses.has(Status));
  const currentWork = records.filter(({ Status }) => ['In Progress', 'In Review'].includes(Status));
  const blockers = records.filter(({ Status }) => Status === 'Blocked');
  return {
    generatedAt: new Date().toISOString(),
    total: records.length,
    statusCounts: Object.fromEntries(Object.entries(statusCounts).map(([status, tasks]) => [status, tasks.length])),
    ownerActions,
    currentWork,
    blockers,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function verifyMutationRequest(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Mutation requests must use Content-Type: application/json.');
    error.statusCode = 415;
    throw error;
  }
  const expectedOrigin = `http://${host}:${activePort}`;
  if (request.headers.origin !== expectedOrigin) {
    const error = new Error('Mutation requests must come from this local tracker page.');
    error.statusCode = 403;
    throw error;
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 196_608) {
      const error = new Error('Request body is limited to 192 KB.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function taskDependencies(record) {
  return String(record.DependsOn ?? '').split(';').map((value) => value.trim()).filter(Boolean);
}

function safePathSegment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(normalized)) {
    const error = new Error(`${label} must use only letters, digits, dot, underscore or hyphen.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function artifactPath(taskId, runId, value) {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(name) || name.includes('..') || name.startsWith('/') || name.endsWith('/')) {
    const error = new Error('Artifact name must be a safe relative path using letters, digits, dot, underscore, hyphen or slash.');
    error.statusCode = 400;
    throw error;
  }
  const artifactDir = join(recordDirectory(taskId, runId), 'artifacts');
  const path = resolve(artifactDir, name);
  if (relative(artifactDir, path).startsWith('..')) {
    const error = new Error('Artifact path escapes its Run artifact directory.');
    error.statusCode = 400;
    throw error;
  }
  return { name, artifactDir, path };
}

function recordDirectory(taskId, runId) {
  return join(taskRecordsDir, safePathSegment(taskId, 'Task ID'), safePathSegment(runId, 'Run ID'));
}

function taskRecordDirectory(taskId) {
  return join(taskRecordsDir, safePathSegment(taskId, 'Task ID'));
}

async function listTaskRuns(taskId) {
  if (!taskRecordsDir) return [];
  const taskDir = join(taskRecordsDir, safePathSegment(taskId, 'Task ID'));
  let entries;
  try {
    entries = await readdir(taskDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const run = JSON.parse(await readFile(join(taskDir, entry.name, 'run.json'), 'utf8'));
      runs.push(run);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return runs.sort((left, right) => String(left.runId).localeCompare(String(right.runId)));
}

async function listRunArtifacts(taskId, runId) {
  const artifactDir = join(recordDirectory(taskId, runId), 'artifacts');
  async function visit(directory, prefix = '') {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const files = [];
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...await visit(join(directory, entry.name), name));
      else if (entry.isFile()) files.push({ name, bytes: (await stat(join(directory, entry.name))).size });
    }
    return files;
  }
  return (await visit(artifactDir)).sort((left, right) => left.name.localeCompare(right.name));
}

async function runForDisplay(run) {
  return { ...run, artifacts: await listRunArtifacts(run.taskId, run.runId) };
}

async function taskRunSummaries(records) {
  const summaries = new Map();
  for (const record of records) {
    const runs = await listTaskRuns(record.TaskID);
    if (!runs.length) continue;
    summaries.set(record.TaskID, {
      count: runs.length,
      current: runs.find((run) => run.status === 'In Progress') ?? null,
      latest: runs.at(-1),
    });
  }
  return summaries;
}

async function readRunEvents(taskId, runId) {
  const eventsPath = join(recordDirectory(taskId, runId), 'events.jsonl');
  let source;
  try {
    source = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function writeRun(run) {
  const directory = recordDirectory(run.taskId, run.runId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'run.json');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function readRun(taskId, runId) {
  const run = JSON.parse(await readFile(join(recordDirectory(taskId, runId), 'run.json'), 'utf8'));
  if (run.taskId !== taskId || run.runId !== runId) {
    const error = new Error('Run record identity does not match the requested task/run path.');
    error.statusCode = 409;
    throw error;
  }
  return run;
}

async function appendRunEvent(taskId, runId, event) {
  const directory = recordDirectory(taskId, runId);
  await stat(join(directory, 'run.json'));
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

function recordsMatch(left, right, header) {
  return header.every((name) => String(left?.[name] ?? '') === String(right?.[name] ?? ''));
}

async function writeCloseIntent(taskId, runId, intent) {
  const directory = recordDirectory(taskId, runId);
  const path = join(directory, 'close-intent.json');
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function readCloseIntent(taskId, runId) {
  try {
    return JSON.parse(await readFile(join(recordDirectory(taskId, runId), 'close-intent.json'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeClaimIntent(taskId, runId, intent) {
  const directory = taskRecordDirectory(taskId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `.claim-intent-${safePathSegment(runId, 'Run ID')}.json`);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

async function listClaimIntents(taskId) {
  const directory = taskRecordDirectory(taskId);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const intents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('.claim-intent-') || !entry.name.endsWith('.json')) continue;
    intents.push({ path: join(directory, entry.name), value: JSON.parse(await readFile(join(directory, entry.name), 'utf8')) });
  }
  return intents;
}

async function recoverPendingClaims(taskId, header, records) {
  const intents = await listClaimIntents(taskId);
  if (!intents.length) return;
  const record = records.find(({ TaskID }) => TaskID === taskId);
  if (!record) {
    const error = new Error(`Task '${taskId}' disappeared while recovering a pending claim.`);
    error.statusCode = 409;
    throw error;
  }
  for (const { path, value: intent } of intents) {
    if (intent.taskId !== taskId || !intent.runId || !intent.run || !intent.beforeRecord || !intent.afterRecord) {
      const error = new Error(`Task '${taskId}' has an invalid claim recovery record; manual repair is required.`);
      error.statusCode = 409;
      throw error;
    }
    let run;
    try {
      run = await readRun(taskId, intent.runId);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (recordsMatch(record, intent.afterRecord, header)) {
      if (!run) {
        await writeRun(intent.run);
        await appendRunEvent(taskId, intent.runId, {
          timestamp: intent.timestamp,
          type: 'claim-recovery',
          result: 'reconstructed',
          message: 'CSV claim committed before the Run record was finalized.',
        });
      } else if (run.status !== 'In Progress') {
        const error = new Error(`Run '${intent.runId}' conflicts with its pending claim recovery record.`);
        error.statusCode = 409;
        throw error;
      }
      await unlink(path);
      continue;
    }
    if (recordsMatch(record, intent.beforeRecord, header)) {
      let run;
      try {
        run = await readRun(taskId, intent.runId);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const abandonedRun = {
        ...(run ?? intent.run),
        status: 'Abandoned',
        abandonedAt: new Date().toISOString(),
        abandonmentReason: 'Claim transaction did not commit to the tracker CSV.',
      };
      await writeRun(abandonedRun);
      await appendRunEvent(taskId, intent.runId, {
        timestamp: abandonedRun.abandonedAt,
        type: 'claim-recovery',
        result: 'abandoned',
        message: 'Run reserved but CSV claim did not commit; identifier will not be reused.',
      });
      await unlink(path);
      continue;
    }
    if (run && run.status !== 'In Progress') {
      // CSV ownership moved beyond the claim state (for example verified then
      // independently rejected). The stale claim intent is no longer a live
      // transaction and must not block a fresh Ready claim.
      await unlink(path);
      continue;
    }
    const error = new Error(`Task '${taskId}' changed outside pending Run '${intent.runId}' claim recovery; manual reconciliation is required.`);
    error.statusCode = 409;
    throw error;
  }
}

async function appendCloseEventOnce(taskId, runId, intent) {
  const eventsPath = join(recordDirectory(taskId, runId), 'events.jsonl');
  let existing = '';
  try {
    existing = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const alreadyRecorded = existing.split('\n').filter(Boolean).some((line) => {
    try {
      return JSON.parse(line).transactionId === intent.transactionId;
    } catch {
      return false;
    }
  });
  if (!alreadyRecorded) {
    await appendRunEvent(taskId, runId, {
      timestamp: intent.closedAt,
      type: 'close',
      result: intent.outcome,
      message: intent.summary,
      transactionId: intent.transactionId,
    });
  }
}

async function recoverPendingClose(taskId, runId) {
  const intent = await readCloseIntent(taskId, runId);
  if (!intent) return false;
  if (intent.taskId !== taskId || intent.runId !== runId || !intent.transactionId
    || !intent.beforeRecord || !intent.afterRecord || !intent.runClosure) {
    const error = new Error(`Run '${runId}' has an invalid close recovery record; manual repair is required.`);
    error.statusCode = 409;
    throw error;
  }
  return withTrackerLock(async () => {
    const current = await readTracker();
    const currentRecord = current.records.find(({ TaskID }) => TaskID === taskId);
    if (!currentRecord) {
      const error = new Error(`Task '${taskId}' disappeared while recovering Run '${runId}'.`);
      error.statusCode = 409;
      throw error;
    }
    const intentPath = join(recordDirectory(taskId, runId), 'close-intent.json');
    if (recordsMatch(currentRecord, intent.afterRecord, current.header)) {
      const run = await readRun(taskId, runId);
      if (run.status !== 'In Progress' && run.status !== intent.runClosure.status) {
        const error = new Error(`Run '${runId}' conflicts with its pending close recovery record.`);
        error.statusCode = 409;
        throw error;
      }
      await appendCloseEventOnce(taskId, runId, intent);
      await writeRun({ ...run, ...intent.runClosure });
      await unlink(intentPath);
      return true;
    }
    if (recordsMatch(currentRecord, intent.beforeRecord, current.header)) {
      // Atomic CSV replacement did not commit. It is safe to discard the intent
      // and let the caller retry against the unchanged revision.
      await unlink(intentPath);
      return false;
    }
    const error = new Error(`Task '${taskId}' changed outside pending Run '${runId}' close recovery; manual reconciliation is required.`);
    error.statusCode = 409;
    throw error;
  });
}

async function recoverTaskPendingCloses(taskId) {
  const runs = await listTaskRuns(taskId);
  for (const run of runs) {
    if (run.status !== 'In Progress') continue;
    await withRunLock(taskId, run.runId, async () => recoverPendingClose(taskId, run.runId));
  }
}

async function artifactUsage(taskId, runId) {
  const files = await listRunArtifacts(taskId, runId);
  return { count: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) };
}

function requireRevision(body, trackerRevision) {
  const requested = String(body?.trackerRevision ?? '').trim();
  if (!requested || requested !== trackerRevision) {
    const error = new Error('Tracker revision is stale. Reload the task packet and try again.');
    error.statusCode = 409;
    throw error;
  }
}

function packetFor(record, records, runs, trackerRevision) {
  const dependencies = taskDependencies(record).map((taskId) => {
    const dependency = records.find(({ TaskID }) => TaskID === taskId);
    return dependency ? {
      taskId,
      status: dependency.Status,
      acceptance: dependency.Acceptance,
      evidence: dependency.Evidence,
      specRef: dependency.SpecRef,
    } : { taskId, missing: true };
  });
  const reverseDependencies = records
    .filter((candidate) => taskDependencies(candidate).includes(record.TaskID))
    .map((candidate) => ({ taskId: candidate.TaskID, status: candidate.Status, task: candidate.Task }));
  return {
    trackerRevision,
    task: record,
    packet: {
      goal: record.Task,
      nonGoals: 'Only the CSV Task Scope, explicit Acceptance, necessary verification and required evidence.',
      acceptance: record.Acceptance,
      specRef: record.SpecRef,
      blocker: record.Blocker,
      availability: record.Status,
      dependencies,
      reverseDependencies,
      existingRuns: runs,
    },
  };
}

function parseRunPath(requestPath) {
  const match = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/(events|artifacts|close)$/.exec(requestPath);
  return match ? {
    taskId: decodeURIComponent(match[1]),
    runId: decodeURIComponent(match[2]),
    operation: match[3],
  } : undefined;
}

function reviewerIdentity(value) {
  const reviewer = String(value ?? '').trim();
  if (!reviewer || reviewer.length > 256 || /[\r\n]/.test(reviewer)) {
    const error = new Error('reviewer is required, must be at most 256 characters and cannot contain a line break.');
    error.statusCode = 400;
    throw error;
  }
  return reviewer;
}

async function serveStatic(request, response) {
  const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
  const relative = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}/`) && filePath !== join(publicDir, 'index.html')) {
    response.writeHead(403).end();
    return;
  }
  try {
    await stat(filePath);
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === 'GET' && requestPath === '/api/tracker') {
      const { records, trackerRevision } = await readTracker();
      const summaries = await taskRunSummaries(records);
      sendJson(response, 200, {
        revision: trackerRevision,
        records: records.map((record) => ({ ...record, RunSummary: summaries.get(record.TaskID) ?? null })),
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/summary') {
      const { records, trackerRevision } = await readTracker();
      sendJson(response, 200, { ...summarize(records), revision: trackerRevision });
      return;
    }
    const packetMatch = /^\/api\/tasks\/([^/]+)\/packet$/.exec(requestPath);
    if (request.method === 'GET' && packetMatch) {
      const taskId = decodeURIComponent(packetMatch[1]);
      const { records, trackerRevision } = await readTracker();
      const record = records.find(({ TaskID }) => TaskID === taskId);
      if (!record) {
        sendJson(response, 404, { error: `Task '${taskId}' was not found.` });
        return;
      }
      sendJson(response, 200, packetFor(record, records, await listTaskRuns(taskId), trackerRevision));
      return;
    }
    const runsMatch = /^\/api\/tasks\/([^/]+)\/runs$/.exec(requestPath);
    if (request.method === 'GET' && runsMatch) {
      const taskId = safePathSegment(decodeURIComponent(runsMatch[1]), 'Task ID');
      const { records } = await readTracker();
      if (!records.some(({ TaskID }) => TaskID === taskId)) {
        sendJson(response, 404, { error: `Task '${taskId}' was not found.` });
        return;
      }
      sendJson(response, 200, { taskId, runs: await Promise.all((await listTaskRuns(taskId)).map(runForDisplay)) });
      return;
    }
    const artifactReadMatch = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(requestPath);
    if (request.method === 'GET' && artifactReadMatch) {
      const taskId = safePathSegment(decodeURIComponent(artifactReadMatch[1]), 'Task ID');
      const runId = safePathSegment(decodeURIComponent(artifactReadMatch[2]), 'Run ID');
      const artifact = artifactPath(taskId, runId, decodeURIComponent(artifactReadMatch[3]));
      const artifactInfo = await stat(artifact.path);
      if (!artifactInfo.isFile()) {
        sendJson(response, 404, { error: `Artifact '${artifact.name}' was not found.` });
        return;
      }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(artifact.path)] ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      createReadStream(artifact.path).pipe(response);
      return;
    }
    const runDetailMatch = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)$/.exec(requestPath);
    if (request.method === 'GET' && runDetailMatch) {
      const taskId = safePathSegment(decodeURIComponent(runDetailMatch[1]), 'Task ID');
      const runId = safePathSegment(decodeURIComponent(runDetailMatch[2]), 'Run ID');
      const run = await readRun(taskId, runId);
      sendJson(response, 200, { run: await runForDisplay(run), events: await readRunEvents(taskId, runId) });
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/runs/start') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(body.taskId, 'Task ID');
      const agent = String(body.agent ?? '').trim();
      const verificationProfile = String(body.verificationProfile ?? '').trim();
      const scope = String(body.scope ?? '').trim();
      const expectedBehavior = String(body.expectedBehavior ?? '').trim();
      if (!agent || !verificationProfile || !scope || !expectedBehavior) {
        sendJson(response, 400, { error: 'agent, verificationProfile, scope and expectedBehavior are required.' });
        return;
      }
      if ([agent, verificationProfile, scope, expectedBehavior].some((value) => value.length > 4_000)) {
        sendJson(response, 400, { error: 'Run fields are limited to 4,000 characters.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        await recoverPendingClaims(taskId, header, records);
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) {
          const error = new Error(`Task '${taskId}' was not found.`);
          error.statusCode = 404;
          throw error;
        }
        if (record.Status !== 'Ready') {
          const error = new Error(`Only Ready tasks can start a managed Run. ${taskId} is '${record.Status}'.`);
          error.statusCode = 409;
          throw error;
        }
        const dependencies = taskDependencies(record);
        const unfinished = dependencies.filter((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status !== 'Done');
        if (unfinished.length) {
          const error = new Error(`Task '${taskId}' has unfinished dependencies: ${unfinished.join(', ')}.`);
          error.statusCode = 409;
          throw error;
        }
        const existingRuns = await listTaskRuns(taskId);
        if (existingRuns.some((run) => run.status === 'In Progress')) {
          const error = new Error(`Task '${taskId}' has an active managed Run and cannot be claimed again.`);
          error.statusCode = 409;
          throw error;
        }
        const nextSequence = Math.max(0, ...existingRuns.map((run) => {
          const match = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-R(\\d+)$`).exec(run.runId);
          return match ? Number(match[1]) : 0;
        })) + 1;
        const runId = `${taskId}-R${String(nextSequence).padStart(4, '0')}`;
        const timestamp = new Date().toISOString();
        const beforeRecord = Object.fromEntries(header.map((name) => [name, record[name] ?? '']));
        const run = {
          runId,
          taskId,
          agent,
          verificationProfile,
          scope,
          expectedBehavior,
          startedAt: timestamp,
          status: 'In Progress',
        };
        record.Status = 'In Progress';
        record.Implementer = agent;
        record.Blocker = '';
        const claimEvidence = `CLAIM: ${agent} ${timestamp}; managed Run ${runId}.`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${claimEvidence}` : claimEvidence;
        record.Updated = timestamp;
        const claimIntent = {
          taskId,
          runId,
          timestamp,
          beforeRecord,
          afterRecord: Object.fromEntries(header.map((name) => [name, record[name] ?? ''])),
          run,
        };
        await writeClaimIntent(taskId, runId, claimIntent);
        await writeRun(run);
        await appendRunEvent(taskId, runId, { timestamp, type: 'claim', result: 'started', message: expectedBehavior });
        if (testClaimFailureRemaining > 0 && (!testClaimFailureTask || testClaimFailureTask === taskId)) {
          testClaimFailureRemaining -= 1;
          throw new Error('Injected test-only claim failure before CSV replacement.');
        }
        await replaceTracker(header, records);
        if (testClaimAfterTrackerFailureRemaining > 0
          && (!testClaimAfterTrackerFailureTask || testClaimAfterTrackerFailureTask === taskId)) {
          testClaimAfterTrackerFailureRemaining -= 1;
          throw new Error('Injected test-only claim failure after CSV replacement.');
        }
        await unlink(join(taskRecordDirectory(taskId), `.claim-intent-${runId}.json`));
        const after = await readTracker();
        return { run, task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 201, result);
      return;
    }
    const runPath = parseRunPath(requestPath);
    if (request.method === 'POST' && runPath) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(runPath.taskId, 'Task ID');
      const runId = safePathSegment(runPath.runId, 'Run ID');
      if (runPath.operation === 'events') {
        const type = String(body.type ?? '').trim();
        const result = String(body.result ?? '').trim();
        const message = String(body.message ?? '').trim();
        if (!type || !result || !message || [type, result, message].some((value) => value.length > 8_000)) {
          sendJson(response, 400, { error: 'type, result and message are required and limited to 8,000 characters.' });
          return;
        }
        const eventResult = await withRunLock(taskId, runId, async () => {
          await recoverPendingClose(taskId, runId);
          const { records, trackerRevision } = await readTracker();
          requireRevision(body, trackerRevision);
          const record = records.find(({ TaskID }) => TaskID === taskId);
          const run = await readRun(taskId, runId);
          if (!record) {
            const error = new Error(`Task '${taskId}' was not found.`);
            error.statusCode = 404;
            throw error;
          }
          if (record.Status !== 'In Progress' || record.Implementer !== run.agent || run.status !== 'In Progress') {
            const error = new Error(`Run '${runId}' is no longer active for task '${taskId}'.`);
            error.statusCode = 409;
            throw error;
          }
          const event = { timestamp: new Date().toISOString(), type, result, message };
          await appendRunEvent(taskId, runId, event);
          return { event, trackerRevision };
        });
        sendJson(response, 201, eventResult);
        return;
      }
      if (runPath.operation === 'artifacts') {
        const requestedName = String(body.name ?? '').trim();
        const content = String(body.content ?? '');
        const byteLength = Buffer.byteLength(content, 'utf8');
        if (!content || byteLength > maxArtifactBytes) {
          sendJson(response, 400, { error: 'Artifact content is required and limited to 128 KB.' });
          return;
        }
        const artifactResult = await withRunLock(taskId, runId, async () => {
          await recoverPendingClose(taskId, runId);
          const { records, trackerRevision } = await readTracker();
          requireRevision(body, trackerRevision);
          const record = records.find(({ TaskID }) => TaskID === taskId);
          const run = await readRun(taskId, runId);
          if (!record) {
            const error = new Error(`Task '${taskId}' was not found.`);
            error.statusCode = 404;
            throw error;
          }
          if (record.Status !== 'In Progress' || record.Implementer !== run.agent || run.status !== 'In Progress') {
            const error = new Error(`Run '${runId}' is no longer active for task '${taskId}'.`);
            error.statusCode = 409;
            throw error;
          }
          const artifact = artifactPath(taskId, runId, requestedName);
          const usage = await artifactUsage(taskId, runId);
          if (usage.count >= maxArtifactCountPerRun || usage.bytes + byteLength > maxArtifactBytesPerRun) {
            const error = new Error(`Run '${runId}' reached its artifact limit (${maxArtifactCountPerRun} files / ${maxArtifactBytesPerRun} bytes).`);
            error.statusCode = 413;
            throw error;
          }
          try {
            await mkdir(dirname(artifact.path), { recursive: true });
            await writeFile(artifact.path, content, { encoding: 'utf8', flag: 'wx' });
          } catch (error) {
            if (error?.code === 'EEXIST') {
              const conflict = new Error(`Artifact '${artifact.name}' already exists for Run '${runId}'; artifacts are immutable.`);
              conflict.statusCode = 409;
              throw conflict;
            }
            throw error;
          }
          const event = { timestamp: new Date().toISOString(), type: 'artifact', result: 'stored', message: `artifacts/${artifact.name}` };
          await appendRunEvent(taskId, runId, event);
          return { artifact: event.message, trackerRevision };
        });
        sendJson(response, 201, artifactResult);
        return;
      }
      const outcome = String(body.outcome ?? '').trim();
      const summary = String(body.summary ?? '').trim();
      const blocker = String(body.blocker ?? '').trim();
      const ownerStatus = String(body.ownerStatus ?? '').trim();
      if (!['verified', 'blocked', 'awaiting-human', 'incomplete'].includes(outcome) || !summary) {
        sendJson(response, 400, { error: 'outcome must be verified, blocked, awaiting-human or incomplete; summary is required.' });
        return;
      }
      const closeResult = await withRunLock(taskId, runId, async () => {
        await recoverPendingClose(taskId, runId);
        return withTrackerLock(async () => {
          const current = await readTracker();
          requireRevision(body, current.trackerRevision);
          const currentRecord = current.records.find(({ TaskID }) => TaskID === taskId);
          const currentRun = await readRun(taskId, runId);
          if (!currentRecord || currentRecord.Status !== 'In Progress' || currentRecord.Implementer !== currentRun.agent || currentRun.status !== 'In Progress') {
            const error = new Error('Task state, Implementer or Run changed while the Run was active. Reload the packet.');
            error.statusCode = 409;
            throw error;
          }
          const timestamp = new Date().toISOString();
          if (outcome === 'incomplete') {
            await appendRunEvent(taskId, runId, { timestamp, type: 'close-attempt', result: outcome, message: summary });
            return { run: currentRun, task: currentRecord, trackerRevision: current.trackerRevision };
          }
          const beforeRecord = Object.fromEntries(current.header.map((name) => [name, currentRecord[name] ?? '']));
          if (outcome === 'verified') {
          currentRecord.Status = 'In Review';
          currentRecord.Blocker = '';
        } else if (outcome === 'blocked') {
          if (!blocker) {
            const error = new Error('blocked outcome requires a concrete blocker.');
            error.statusCode = 400;
            throw error;
          }
          currentRecord.Status = 'Blocked';
          currentRecord.Blocker = blocker;
        } else if (outcome === 'awaiting-human') {
          if (!['Awaiting Owner', 'Awaiting Owner Gate'].includes(ownerStatus)) {
            const error = new Error('awaiting-human requires ownerStatus to be Awaiting Owner or Awaiting Owner Gate.');
            error.statusCode = 409;
            throw error;
          }
          currentRecord.Status = ownerStatus;
          currentRecord.Blocker = blocker || 'Human action is required before workflow can continue.';
        } else {
          currentRecord.Status = 'In Progress';
        }
        currentRecord.Evidence = currentRecord.Evidence ? `${currentRecord.Evidence}\nRUN ${runId} ${outcome}: ${summary}` : `RUN ${runId} ${outcome}: ${summary}`;
        currentRecord.Updated = timestamp;
          const runClosure = {
            status: outcome,
            closedAt: timestamp,
            summary,
            blocker: currentRecord.Blocker,
          };
          const intent = {
            transactionId: randomUUID(),
            taskId,
            runId,
            outcome,
            summary,
            closedAt: timestamp,
            beforeRecord,
            afterRecord: Object.fromEntries(current.header.map((name) => [name, currentRecord[name] ?? ''])),
            runClosure,
          };
          await writeCloseIntent(taskId, runId, intent);
          await replaceTracker(current.header, current.records);
          if (testCloseFailureRemaining > 0) {
            testCloseFailureRemaining -= 1;
            throw new Error('Injected test-only close failure after CSV replacement.');
          }
          await appendCloseEventOnce(taskId, runId, intent);
          const closedRun = { ...currentRun, ...runClosure };
          await writeRun(closedRun);
          await unlink(join(recordDirectory(taskId, runId), 'close-intent.json'));
          const after = await readTracker();
          return { run: closedRun, task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
        });
      });
      sendJson(response, 200, closeResult);
      return;
    }
    const reviewMatch = /^\/api\/tasks\/([^/]+)\/review$/.exec(requestPath);
    if (request.method === 'POST' && reviewMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(reviewMatch[1]), 'Task ID');
      await recoverTaskPendingCloses(taskId);
      const action = String(body.action ?? '').trim();
      const reviewer = reviewerIdentity(body.reviewer);
      if (!['claim', 'decision'].includes(action)) {
        sendJson(response, 400, { error: 'action must be claim or decision.' });
        return;
      }
      const decision = String(body.decision ?? '').trim();
      const notes = String(body.notes ?? '').trim();
      const reviewBlocker = String(body.blocker ?? '').trim();
      if (action === 'decision' && (!['approved', 'rejected', 'blocked'].includes(decision) || !notes || notes.length > 8_000)) {
        sendJson(response, 400, { error: 'decision must be approved, rejected or blocked, with notes limited to 8,000 characters.' });
        return;
      }
      if (action === 'decision' && decision === 'blocked' && (!reviewBlocker || reviewBlocker.length > 4_000)) {
        sendJson(response, 400, { error: 'A blocked review decision requires a concrete blocker limited to 4,000 characters.' });
        return;
      }
      const reviewResult = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) {
          const error = new Error(`Task '${taskId}' was not found.`);
          error.statusCode = 404;
          throw error;
        }
        if (record.Status !== 'In Review') {
          const error = new Error(`Only In Review tasks can be reviewed. ${taskId} is '${record.Status}'.`);
          error.statusCode = 409;
          throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' has unresolved active Run '${activeRun.runId}' and cannot be reviewed.`);
          error.statusCode = 409;
          throw error;
        }
        if (!record.Implementer || record.Implementer === reviewer) {
          const error = new Error('Reviewer must be distinct from the task Implementer.');
          error.statusCode = 409;
          throw error;
        }
        const timestamp = new Date().toISOString();
        if (action === 'claim') {
          if (record.ReviewClaim) {
            const error = new Error(`Task '${taskId}' already has a ReviewClaim.`);
            error.statusCode = 409;
            throw error;
          }
          record.ReviewClaim = `REVIEW-CLAIM: ${reviewer} ${timestamp}`;
          record.Updated = timestamp;
          await replaceTracker(header, records);
          const after = await readTracker();
          return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
        }
        const expectedClaimPrefix = `REVIEW-CLAIM: ${reviewer} `;
        if (!record.ReviewClaim?.startsWith(expectedClaimPrefix)) {
          const error = new Error(`Reviewer '${reviewer}' has not claimed task '${taskId}'.`);
          error.statusCode = 409;
          throw error;
        }
        record.Reviewer = `${reviewer} / ${decision} / ${timestamp}`;
        const evidence = `REVIEW ${decision}: ${reviewer} ${timestamp}; ${notes}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${evidence}` : evidence;
        record.Updated = timestamp;
        if (decision === 'approved') {
          record.Status = 'Done';
          record.Blocker = '';
          record.ReviewClaim = '';
        } else if (decision === 'blocked') {
          record.Status = 'Blocked';
          record.Blocker = reviewBlocker;
          record.ReviewClaim = '';
        } else {
          record.Status = 'Ready';
          record.Implementer = '';
          record.ReviewClaim = '';
          record.Blocker = '';
        }
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, reviewResult);
      return;
    }
    const blockMatch = /^\/api\/tasks\/([^/]+)\/block$/.exec(requestPath);
    if (request.method === 'POST' && blockMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(blockMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const blocker = String(body.blocker ?? '').trim();
      const evidence = String(body.evidence ?? '').trim();
      if (!blocker || blocker.length > 4_000 || !evidence || evidence.length > 8_000) {
        sendJson(response, 400, { error: 'agent, concrete blocker and evidence are required within their size limits.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) {
          const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error;
        }
        if (record.Status !== 'Ready') {
          const error = new Error(`Only an unclaimed Ready task can use pre-claim block. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        record.Status = 'Blocked'; record.Blocker = blocker; record.Updated = timestamp;
        const line = `ESCALATION BLOCKED: ${agent} ${timestamp}; ${evidence}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const unblockMatch = /^\/api\/tasks\/([^/]+)\/unblock$/.exec(requestPath);
    if (request.method === 'POST' && unblockMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(unblockMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const reason = String(body.reason ?? '').trim();
      if (!reason || reason.length > 8_000) {
        sendJson(response, 400, { error: 'A concrete dependency-unblock reason is required within 8,000 characters.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (record.Status !== 'Blocked' || record.Implementer || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed ordinary Blocked task may be dependency-unblocked. ${taskId} is not eligible.`); error.statusCode = 409; throw error;
        }
        const dependencies = taskDependencies(record);
        if (!dependencies.length) { const error = new Error(`Cannot dependency-unblock ${taskId}; it has no dependencies.`); error.statusCode = 409; throw error; }
        const unfinished = dependencies.filter((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status !== 'Done');
        if (unfinished.length) { const error = new Error(`Cannot unblock ${taskId}; unfinished dependencies: ${unfinished.join(', ')}.`); error.statusCode = 409; throw error; }
        const timestamp = new Date().toISOString();
        record.Status = 'Ready'; record.Blocker = ''; record.Updated = timestamp;
        const line = `UNBLOCKED: ${dependencies.join(';') || 'no dependencies'}; ${timestamp}; ${agent}; ${reason}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/feedback') {
      verifyMutationRequest(request);
      const { taskId, feedback } = await readJson(request);
      const normalizedTaskId = String(taskId ?? '').trim();
      const normalizedFeedback = String(feedback ?? '').trim();
      if (!normalizedTaskId || !normalizedFeedback) {
        sendJson(response, 400, { error: 'Task ID and feedback are both required.' });
        return;
      }
      if (normalizedFeedback.length > 8_000) {
        sendJson(response, 400, { error: 'Feedback is limited to 8,000 characters.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === normalizedTaskId);
        if (!record) {
          const error = new Error(`Task '${normalizedTaskId}' was not found.`);
          error.statusCode = 404;
          throw error;
        }
        if (!ownerInputStatuses.has(record.Status)) {
          const error = new Error(`Feedback is only enabled for owner-facing tasks. ${normalizedTaskId} is '${record.Status}'.`);
          error.statusCode = 409;
          throw error;
        }
        const timestamp = new Date().toISOString();
        const evidence = `[OWNER FEEDBACK ${timestamp}] ${normalizedFeedback}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${evidence}` : evidence;
        record.Status = 'Awaiting Agent Evaluation';
        record.Blocker = 'Owner feedback submitted; Agent evaluation required before any workflow transition.';
        record.Updated = timestamp;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { record, timestamp, trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'GET') {
      await serveStatic(request, response);
      return;
    }
    response.writeHead(405, { Allow: 'GET, POST', 'X-Content-Type-Options': 'nosniff' }).end();
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error.message ?? 'Unexpected server error.' });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  activePort = typeof address === 'object' && address ? address.port : port;
  console.log(`Task tracker is available at http://${host}:${activePort}`);
  console.log(`CSV source of truth: ${trackerPath}`);
});
