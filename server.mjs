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
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '127.0.0.1';
let activePort = port;
const ownerInputStatuses = new Set([
  'Awaiting Owner',
  'Awaiting Owner Gate',
  'Awaiting Agent Evaluation',
]);
const runStartStatuses = new Set(['Ready', 'In Progress']);
const runOutcomes = new Set(['verified', 'awaiting-human', 'blocked', 'incomplete']);
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const artifactNamePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
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

function trackerRevision(source) {
  return createHash('sha256').update(source).digest('hex');
}

function taskRecordsRoot() {
  if (!trackerPath) throw new Error('No tracker is configured.');
  return join(dirname(trackerPath), 'task-records');
}

function assertTaskId(taskId) {
  if (!taskIdPattern.test(taskId)) {
    const error = new Error('Task ID must contain only letters, digits, underscores, or hyphens.');
    error.statusCode = 400;
    throw error;
  }
}

function assertRunId(taskId, runId) {
  assertTaskId(taskId);
  if (!new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-R\\d{4,}$`).test(runId)) {
    const error = new Error(`Run ID must use the ${taskId}-R0001 format.`);
    error.statusCode = 400;
    throw error;
  }
}

function safeArtifactPath(runDirectory, artifactName) {
  if (!artifactNamePattern.test(artifactName) || artifactName.includes('..') || artifactName.startsWith('/')) {
    const error = new Error('Artifact name must be a relative safe path.');
    error.statusCode = 400;
    throw error;
  }
  const artifactPath = resolve(runDirectory, artifactName);
  if (relative(runDirectory, artifactPath).startsWith('..')) {
    const error = new Error('Artifact path escapes its run directory.');
    error.statusCode = 400;
    throw error;
  }
  return artifactPath;
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
  return { header, records, revision: trackerRevision(source) };
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

function requireTrackerRevision(actualRevision, expectedRevision) {
  if (!expectedRevision || expectedRevision !== actualRevision) {
    const error = new Error('Tracker revision is stale. Reload task data before changing task execution state.');
    error.statusCode = 409;
    throw error;
  }
}

function runDirectory(taskId, runId) {
  assertRunId(taskId, runId);
  return join(taskRecordsRoot(), taskId, runId);
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readRun(taskId, runId) {
  const directory = runDirectory(taskId, runId);
  const manifest = await readJsonFile(join(directory, 'manifest.json'), null);
  if (!manifest) {
    const error = new Error(`Run '${runId}' was not found for task '${taskId}'.`);
    error.statusCode = 404;
    throw error;
  }
  const eventSource = await readFile(join(directory, 'events.jsonl'), 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  const events = eventSource.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { directory, manifest, events };
}

async function listRuns(taskId) {
  assertTaskId(taskId);
  const taskDirectory = join(taskRecordsRoot(), taskId);
  const entries = await readdir(taskDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonFile(join(taskDirectory, entry.name, 'manifest.json'), null);
    if (manifest?.taskId === taskId && manifest?.runId === entry.name) manifests.push(manifest);
  }
  return manifests.sort((left, right) => right.sequence - left.sequence);
}

async function taskRunSummaries(records) {
  const summaries = new Map();
  for (const record of records) {
    if (!taskIdPattern.test(record.TaskID || '')) continue;
    const runs = await listRuns(record.TaskID);
    if (!runs.length) continue;
    summaries.set(record.TaskID, {
      count: runs.length,
      current: runs.find((run) => run.status === 'running') ?? null,
      latest: runs[0],
    });
  }
  return summaries;
}

function runEvidenceLine(timestamp, run, message) {
  return `[AGENT RUN ${timestamp}] ${run.runId} ${message} (tracker/task-records/${run.taskId}/${run.runId}/)`;
}

async function writeRunManifest(directory, manifest) {
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function appendRunEvent(directory, event) {
  await appendFile(join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
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

function verifyFeedbackRequest(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    const error = new Error('Feedback requests must use Content-Type: application/json.');
    error.statusCode = 415;
    throw error;
  }
  const expectedOrigin = `http://${host}:${activePort}`;
  if (request.headers.origin !== expectedOrigin) {
    const error = new Error('Feedback requests must come from this local tracker page.');
    error.statusCode = 403;
    throw error;
  }
}

async function readJson(request, maxBytes = 16_384) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`Request body is limited to ${Math.floor(maxBytes / 1024)} KB.`);
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

function requiredText(value, name, maxLength = 4_000) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    const error = new Error(`${name} is required.`);
    error.statusCode = 400;
    throw error;
  }
  if (normalized.length > maxLength) {
    const error = new Error(`${name} is limited to ${maxLength} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function optionalText(value, name, maxLength = 4_000) {
  if (value === undefined || value === null || value === '') return '';
  return requiredText(value, name, maxLength);
}

function taskIdFromPath(requestPath, suffix) {
  const prefix = '/api/tasks/';
  if (!requestPath.startsWith(prefix) || !requestPath.endsWith(suffix)) return null;
  const taskId = decodeURIComponent(requestPath.slice(prefix.length, -suffix.length));
  assertTaskId(taskId);
  return taskId;
}

function runPathParts(requestPath, tail = '') {
  const match = new RegExp(`^/api/tasks/([^/]+)/runs/([^/]+)${tail}$`).exec(requestPath);
  if (!match) return null;
  const taskId = decodeURIComponent(match[1]);
  const runId = decodeURIComponent(match[2]);
  assertRunId(taskId, runId);
  return { taskId, runId };
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

async function startRun(body) {
  const taskId = requiredText(body.taskId, 'taskId', 128);
  assertTaskId(taskId);
  const agent = optionalText(body.agent, 'agent', 256) || 'unspecified-agent';
  const verificationProfile = requiredText(body.verificationProfile, 'verificationProfile', 128);
  const gitRevision = optionalText(body.gitRevision, 'gitRevision', 256);
  const unityVersion = optionalText(body.unityVersion, 'unityVersion', 256);
  const scopeSummary = optionalText(body.scopeSummary, 'scopeSummary', 4_000);
  const expectedBehavior = optionalText(body.expectedBehavior, 'expectedBehavior', 4_000);
  const timestamp = new Date().toISOString();

  return withTrackerLock(async () => {
    const { header, records, revision } = await readTracker();
    requireTrackerRevision(revision, body.trackerRevision);
    const record = records.find(({ TaskID }) => TaskID === taskId);
    if (!record) {
      const error = new Error(`Task '${taskId}' was not found.`);
      error.statusCode = 404;
      throw error;
    }
    if (!runStartStatuses.has(record.Status)) {
      const error = new Error(`Task '${taskId}' is '${record.Status}' and cannot start an Agent run.`);
      error.statusCode = 409;
      throw error;
    }
    const runs = await listRuns(taskId);
    const activeRun = runs.find((run) => run.status === 'running');
    if (activeRun) {
      const error = new Error(`Task '${taskId}' already has active run '${activeRun.runId}'. Close or escalate it before starting another run.`);
      error.statusCode = 409;
      throw error;
    }
    const sequence = Math.max(0, ...runs.map((run) => Number(run.sequence) || 0)) + 1;
    const runId = `${taskId}-R${String(sequence).padStart(4, '0')}`;
    const directory = runDirectory(taskId, runId);
    const manifest = {
      schemaVersion: 1,
      taskId,
      runId,
      sequence,
      status: 'running',
      phase: 'PREFLIGHT',
      outcome: null,
      agent,
      verificationProfile,
      gitRevision,
      unityVersion,
      scopeSummary,
      expectedBehavior,
      startedAt: timestamp,
      closedAt: null,
      artifacts: [],
    };
    await mkdir(directory, { recursive: true });
    await writeRunManifest(directory, manifest);
    await appendRunEvent(directory, {
      seq: 1,
      time: timestamp,
      phase: 'PREFLIGHT',
      kind: 'run-started',
      result: 'ok',
      message: `Started by ${agent} using ${verificationProfile}.`,
    });
    record.Status = 'In Progress';
    record.Blocker = '';
    record.Evidence = record.Evidence
      ? `${record.Evidence}\n${runEvidenceLine(timestamp, manifest, `started with profile ${verificationProfile}`)}`
      : runEvidenceLine(timestamp, manifest, `started with profile ${verificationProfile}`);
    record.Updated = timestamp;
    await replaceTracker(header, records);
    const next = await readTracker();
    return { run: manifest, record, trackerRevision: next.revision };
  });
}

async function addRunEvent(taskId, runId, body) {
  const phase = requiredText(body.phase, 'phase', 64);
  const kind = requiredText(body.kind, 'kind', 128);
  const result = optionalText(body.result, 'result', 64);
  const message = optionalText(body.message, 'message', 8_000);
  const attempt = optionalText(body.attempt, 'attempt', 64);
  return withTrackerLock(async () => {
    const { directory, manifest, events } = await readRun(taskId, runId);
    if (manifest.status !== 'running') {
      const error = new Error(`Run '${runId}' is closed and cannot receive new execution events.`);
      error.statusCode = 409;
      throw error;
    }
    const event = {
      seq: events.length + 1,
      time: new Date().toISOString(),
      phase,
      kind,
      result: result || undefined,
      attempt: attempt || undefined,
      message: message || undefined,
    };
    manifest.phase = phase;
    await appendRunEvent(directory, event);
    await writeRunManifest(directory, manifest);
    return { event, run: manifest };
  });
}

async function writeRunArtifact(taskId, runId, body) {
  const name = requiredText(body.name, 'name', 256);
  if (typeof body.content !== 'string') {
    const error = new Error('Artifact content must be a UTF-8 string.');
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(body.content, 'utf8') > 512 * 1024) {
    const error = new Error('A single text artifact is limited to 512 KB. Store larger or binary evidence externally and record its reference.');
    error.statusCode = 413;
    throw error;
  }
  return withTrackerLock(async () => {
    const { directory, manifest, events } = await readRun(taskId, runId);
    if (manifest.status !== 'running') {
      const error = new Error(`Run '${runId}' is closed and cannot receive new artifacts.`);
      error.statusCode = 409;
      throw error;
    }
    const artifactPath = safeArtifactPath(directory, name);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, body.content, 'utf8');
    const artifact = { name, bytes: Buffer.byteLength(body.content, 'utf8'), writtenAt: new Date().toISOString() };
    manifest.artifacts = [...(manifest.artifacts ?? []).filter((item) => item.name !== name), artifact];
    const event = {
      seq: events.length + 1,
      time: artifact.writtenAt,
      phase: manifest.phase,
      kind: 'artifact-written',
      result: 'ok',
      message: `${name} (${artifact.bytes} bytes)`,
    };
    await appendRunEvent(directory, event);
    await writeRunManifest(directory, manifest);
    return { artifact, run: manifest };
  });
}

async function closeRun(taskId, runId, body) {
  const outcome = requiredText(body.outcome, 'outcome', 64);
  if (!runOutcomes.has(outcome)) {
    const error = new Error(`outcome must be one of: ${[...runOutcomes].join(', ')}.`);
    error.statusCode = 400;
    throw error;
  }
  const summary = requiredText(body.summary, 'summary', 8_000);
  const blocker = optionalText(body.blocker, 'blocker', 4_000);
  if (outcome === 'blocked' && !blocker) {
    const error = new Error('blocked outcome requires a concrete blocker.');
    error.statusCode = 400;
    throw error;
  }
  return withTrackerLock(async () => {
    const { header, records, revision } = await readTracker();
    requireTrackerRevision(revision, body.trackerRevision);
    const record = records.find(({ TaskID }) => TaskID === taskId);
    if (!record) {
      const error = new Error(`Task '${taskId}' was not found.`);
      error.statusCode = 404;
      throw error;
    }
    const { directory, manifest, events } = await readRun(taskId, runId);
    if (manifest.status !== 'running') {
      const error = new Error(`Run '${runId}' is already closed.`);
      error.statusCode = 409;
      throw error;
    }
    const timestamp = new Date().toISOString();
    manifest.status = 'closed';
    manifest.phase = 'CLOSED';
    manifest.outcome = outcome;
    manifest.summary = summary;
    manifest.blocker = blocker;
    manifest.closedAt = timestamp;
    await appendRunEvent(directory, {
      seq: events.length + 1,
      time: timestamp,
      phase: 'CLOSED',
      kind: 'run-closed',
      result: outcome,
      message: summary,
    });
    await writeRunManifest(directory, manifest);

    if (outcome === 'verified') {
      record.Status = 'In Review';
      record.Blocker = 'Technical verification passed; independent review is still required before Done.';
    } else if (outcome === 'awaiting-human') {
      record.Status = 'Awaiting Owner Gate';
      record.Blocker = blocker || 'Technical verification passed; human experience acceptance is required.';
    } else if (outcome === 'blocked') {
      record.Status = 'Blocked';
      record.Blocker = blocker;
    } else {
      record.Status = 'In Progress';
      record.Blocker = blocker || 'Agent run ended without sufficient verification evidence; follow-up is required.';
    }
    record.Evidence = record.Evidence
      ? `${record.Evidence}\n${runEvidenceLine(timestamp, manifest, `closed as ${outcome}: ${summary}`)}`
      : runEvidenceLine(timestamp, manifest, `closed as ${outcome}: ${summary}`);
    record.Updated = timestamp;
    await replaceTracker(header, records);
    const next = await readTracker();
    return { run: manifest, record, trackerRevision: next.revision };
  });
}

const server = createServer(async (request, response) => {
  try {
    const requestPath = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (request.method === 'GET' && requestPath === '/api/tracker') {
      const { records, revision } = await readTracker();
      const summaries = await taskRunSummaries(records);
      sendJson(response, 200, {
        revision,
        records: records.map((record) => ({ ...record, RunSummary: summaries.get(record.TaskID) ?? null })),
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/summary') {
      const { records, revision } = await readTracker();
      sendJson(response, 200, { ...summarize(records), revision });
      return;
    }
    const packetTaskId = request.method === 'GET' ? taskIdFromPath(requestPath, '/packet') : null;
    if (packetTaskId) {
      const { records, revision } = await readTracker();
      const task = records.find(({ TaskID }) => TaskID === packetTaskId);
      if (!task) {
        const error = new Error(`Task '${packetTaskId}' was not found.`);
        error.statusCode = 404;
        throw error;
      }
      const dependencies = (task.DependsOn || '').split(/[;,\s]+/).filter(Boolean);
      const dependents = records.filter((record) => (record.DependsOn || '').split(/[;,\s]+/).includes(packetTaskId));
      const runs = await listRuns(packetTaskId);
      sendJson(response, 200, { task, dependencies, dependents, runs, trackerRevision: revision });
      return;
    }
    const runsTaskId = request.method === 'GET' ? taskIdFromPath(requestPath, '/runs') : null;
    if (runsTaskId) {
      sendJson(response, 200, { taskId: runsTaskId, runs: await listRuns(runsTaskId) });
      return;
    }
    const artifactMatch = request.method === 'GET'
      ? /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/artifacts\/(.+)$/.exec(requestPath)
      : null;
    if (artifactMatch) {
      const taskId = decodeURIComponent(artifactMatch[1]);
      const runId = decodeURIComponent(artifactMatch[2]);
      assertRunId(taskId, runId);
      const directory = runDirectory(taskId, runId);
      const artifactPath = safeArtifactPath(directory, decodeURIComponent(artifactMatch[3]));
      const artifactStat = await stat(artifactPath);
      if (!artifactStat.isFile()) {
        const error = new Error('Artifact path is not a file.');
        error.statusCode = 404;
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': mimeTypes[extname(artifactPath)] ?? 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      createReadStream(artifactPath).pipe(response);
      return;
    }
    const runDetail = request.method === 'GET' ? runPathParts(requestPath) : null;
    if (runDetail) {
      const { manifest, events } = await readRun(runDetail.taskId, runDetail.runId);
      sendJson(response, 200, { run: manifest, events });
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/feedback') {
      verifyFeedbackRequest(request);
      const body = await readJson(request);
      const { taskId, feedback } = body;
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
        const { header, records, revision } = await readTracker();
        requireTrackerRevision(revision, body.trackerRevision);
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
        const next = await readTracker();
        return { record, timestamp, trackerRevision: next.revision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/runs/start') {
      verifyFeedbackRequest(request);
      sendJson(response, 201, await startRun(await readJson(request, 64 * 1024)));
      return;
    }
    const eventRun = request.method === 'POST' ? runPathParts(requestPath, '/events') : null;
    if (eventRun) {
      verifyFeedbackRequest(request);
      sendJson(response, 201, await addRunEvent(eventRun.taskId, eventRun.runId, await readJson(request, 32 * 1024)));
      return;
    }
    const artifactRun = request.method === 'POST' ? runPathParts(requestPath, '/artifacts') : null;
    if (artifactRun) {
      verifyFeedbackRequest(request);
      sendJson(response, 201, await writeRunArtifact(artifactRun.taskId, artifactRun.runId, await readJson(request, 540 * 1024)));
      return;
    }
    const closingRun = request.method === 'POST' ? runPathParts(requestPath, '/close') : null;
    if (closingRun) {
      verifyFeedbackRequest(request);
      sendJson(response, 200, await closeRun(closingRun.taskId, closingRun.runId, await readJson(request, 32 * 1024)));
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
