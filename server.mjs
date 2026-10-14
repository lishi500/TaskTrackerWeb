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
const workflow = config.workflow ?? {};
const serialLaneEnabled = process.env.TASK_HUB_SERIAL_LANE
  ? process.env.TASK_HUB_SERIAL_LANE === 'true'
  : workflow.serialLane === true;
const ownerGateTaskPattern = new RegExp(workflow.ownerGateTaskPattern ?? '^GATE-');
const ownerInputStatuses = new Set([
  'Awaiting Owner',
  'Awaiting Owner Gate',
  'Awaiting Agent Evaluation',
]);
const taskCreationColumns = [
  'TaskID', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef',
  'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance',
  'ReviewRequired', 'Blocker', 'Implementer', 'Evidence', 'Updated',
  'ReviewClaim', 'Reviewer',
];
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

async function readRawTracker() {
  if (!trackerPath) {
    const error = new Error('No tracker is configured. Add a project to task-hub.config.json or set TRACKER_CSV.');
    error.statusCode = 503;
    throw error;
  }
  const source = await readFile(trackerPath, 'utf8');
  const trackerRevision = createHash('sha256').update(source).digest('hex');
  let rows;
  try {
    rows = parseCsv(source);
  } catch (error) {
    return {
      header: [],
      records: [],
      trackerRevision,
      csvErrors: [{ code: 'csv-parse', message: error.message }],
    };
  }
  const [rawHeader, ...body] = rows;
  const header = rawHeader ?? [];
  const csvErrors = [];
  if (!header?.includes('TaskID') || !header.includes('Status')) {
    csvErrors.push({ code: 'required-columns', message: 'task_tracker.csv must contain TaskID and Status columns.' });
  }
  const duplicateColumns = [...new Set(header.filter((name, index) => header.indexOf(name) !== index))];
  if (duplicateColumns.length) {
    csvErrors.push({ code: 'duplicate-columns', columns: duplicateColumns, message: `CSV header has duplicate columns: ${duplicateColumns.join(', ')}.` });
  }
  const taskIdIndex = header.indexOf('TaskID');
  const wellFormedRows = [];
  body.forEach((values, index) => {
    if (values.length !== header.length) {
      const taskId = taskIdIndex >= 0 ? values[taskIdIndex] || '<missing TaskID>' : '<unknown TaskID>';
      csvErrors.push({
        code: 'row-width',
        line: index + 2,
        taskId,
        fieldCount: values.length,
        expectedFieldCount: header.length,
        message: `line ${index + 2} (${taskId}: ${values.length}/${header.length} fields)`,
      });
      return;
    }
    wellFormedRows.push(values);
  });
  const records = wellFormedRows.map((values) => Object.fromEntries(header.map((name, index) => [name, values[index]])));
  return {
    header,
    records,
    trackerRevision,
    csvErrors,
  };
}

function canonicalCyclePath(path) {
  const nodes = path.slice(0, -1);
  const rotations = nodes.map((_, index) => [...nodes.slice(index), ...nodes.slice(0, index)]);
  rotations.sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')));
  return [...rotations[0], rotations[0][0]];
}

function validateDependencyGraph(records) {
  const normalized = records.map((record, rowIndex) => ({ record, rowIndex, taskId: String(record.TaskID ?? '').trim() }));
  const missingTaskIds = normalized
    .filter(({ taskId }) => !taskId)
    .map(({ rowIndex }) => ({ line: rowIndex + 2 }));
  const ids = new Map();
  for (const entry of normalized) {
    if (!entry.taskId) continue;
    const entries = ids.get(entry.taskId) ?? [];
    entries.push(entry);
    ids.set(entry.taskId, entries);
  }
  const duplicateTaskIds = [...ids.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([taskId, entries]) => ({ taskId, lines: entries.map(({ rowIndex }) => rowIndex + 2) }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
  const uniqueRecords = new Map([...ids.entries()]
    .filter(([, entries]) => entries.length === 1)
    .map(([taskId, [entry]]) => [taskId, entry.record]));
  const unknownDependencies = [];
  const selfDependencies = [];
  const duplicateDependencies = [];
  let edgeCount = 0;

  for (const taskId of [...uniqueRecords.keys()].sort()) {
    const dependencies = taskDependencies(uniqueRecords.get(taskId));
    edgeCount += dependencies.length;
    const dependencyCounts = new Map();
    for (const dependencyId of dependencies) dependencyCounts.set(dependencyId, (dependencyCounts.get(dependencyId) ?? 0) + 1);
    const duplicates = [...dependencyCounts.entries()].filter(([, count]) => count > 1).map(([dependencyId]) => dependencyId).sort();
    if (duplicates.length) duplicateDependencies.push({ taskId, dependencyIds: duplicates });
    for (const dependencyId of [...new Set(dependencies)].sort()) {
      if (dependencyId === taskId) {
        selfDependencies.push(taskId);
      } else if (!uniqueRecords.has(dependencyId)) {
        unknownDependencies.push({ taskId, dependencyId });
      }
    }
  }

  const state = new Map();
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();
  const visit = (taskId) => {
    state.set(taskId, 'visiting');
    stack.push(taskId);
    const dependencies = [...new Set(taskDependencies(uniqueRecords.get(taskId)))].filter((dependencyId) => uniqueRecords.has(dependencyId)).sort();
    for (const dependencyId of dependencies) {
      if (state.get(dependencyId) === 'visiting') {
        const cycle = canonicalCyclePath([...stack.slice(stack.indexOf(dependencyId)), dependencyId]);
        const key = cycle.join('\u0000');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push({ taskIds: cycle, path: cycle.join(' -> ') });
        }
      } else if (!state.has(dependencyId)) {
        visit(dependencyId);
      }
    }
    stack.pop();
    state.set(taskId, 'visited');
  };
  for (const taskId of [...uniqueRecords.keys()].sort()) {
    if (!state.has(taskId)) visit(taskId);
  }
  cycles.sort((left, right) => left.path.localeCompare(right.path));
  const report = {
    valid: missingTaskIds.length === 0
      && duplicateTaskIds.length === 0
      && unknownDependencies.length === 0
      && selfDependencies.length === 0
      && duplicateDependencies.length === 0
      && cycles.length === 0,
    taskCount: records.length,
    edgeCount,
    missingTaskIds,
    duplicateTaskIds,
    unknownDependencies,
    selfDependencies: [...new Set(selfDependencies)].sort(),
    duplicateDependencies,
    cycles,
  };
  return report;
}

function dependencyAudit(raw) {
  const graph = validateDependencyGraph(raw.records);
  return {
    ...graph,
    valid: raw.csvErrors.length === 0 && graph.valid,
    csvErrors: raw.csvErrors,
  };
}

function dependencyAuditMessage(audit) {
  const issues = [];
  if (audit.csvErrors.length) issues.push(`${audit.csvErrors.length} CSV structure error(s)`);
  if (audit.missingTaskIds.length) issues.push(`${audit.missingTaskIds.length} missing TaskID(s)`);
  if (audit.duplicateTaskIds.length) issues.push(`duplicate TaskID(s): ${audit.duplicateTaskIds.map(({ taskId }) => taskId).join(', ')}`);
  if (audit.unknownDependencies.length) issues.push(`unknown dependency reference(s): ${audit.unknownDependencies.map(({ taskId, dependencyId }) => `${taskId} -> ${dependencyId}`).join(', ')}`);
  if (audit.selfDependencies.length) issues.push(`self dependency: ${audit.selfDependencies.join(', ')}`);
  if (audit.duplicateDependencies.length) issues.push(`duplicate dependency reference(s) on ${audit.duplicateDependencies.map(({ taskId }) => taskId).join(', ')}`);
  if (audit.cycles.length) issues.push(`dependency cycle(s): ${audit.cycles.map(({ path }) => path).join('; ')}`);
  return `Tracker dependency audit failed: ${issues.join('; ')}.`;
}

function assertValidDependencyAudit(audit) {
  if (audit.valid) return;
  const error = new Error(dependencyAuditMessage(audit));
  error.statusCode = 422;
  error.dependencyAudit = audit;
  throw error;
}

async function readTracker() {
  const raw = await readRawTracker();
  assertValidDependencyAudit(dependencyAudit(raw));
  return raw;
}

async function replaceTracker(header, records) {
  if (!trackerPath) throw new Error('No tracker is configured.');
  assertValidDependencyAudit(dependencyAudit({ header, records, csvErrors: [] }));
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

const serialLaneStatuses = new Set(['Ready', 'In Progress', 'In Review']);

function isAgentTask(record) {
  return String(record.ReviewRequired ?? '').trim().toLowerCase() === 'yes';
}

function serialLaneOccupants(records, excludedTaskId = '') {
  if (!serialLaneEnabled) return [];
  return records.filter((record) => record.TaskID !== excludedTaskId && isAgentTask(record) && serialLaneStatuses.has(record.Status));
}

function assertSerialLaneAvailable(records, taskId) {
  const occupants = serialLaneOccupants(records, taskId);
  if (!occupants.length) return;
  const error = new Error(`Serial lane is occupied by ${occupants.map(({ TaskID, Status }) => `${TaskID} (${Status})`).join(', ')}. Finish/review it before admitting or claiming another Agent task.`);
  error.statusCode = 409;
  throw error;
}

function dependenciesOtherThan(record, taskId) {
  return taskDependencies(record).filter((dependencyId) => dependencyId !== taskId);
}

function allDependenciesDone(records, record) {
  return taskDependencies(record).every((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status === 'Done');
}

function armedMarker(taskId) {
  return `ARMED: waiting for active predecessor ${taskId};`;
}

function isArmedBy(record, taskId) {
  return record.Status === 'Blocked' && record.Evidence?.includes(armedMarker(taskId));
}

function appendEvidence(record, line) {
  record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
}

function armImmediateSuccessor(records, predecessor, timestamp) {
  if (!serialLaneEnabled || !isAgentTask(predecessor) || !['In Progress', 'In Review'].includes(predecessor.Status)) return [];
  const candidates = records.filter((record) => record.Status === 'Backlog'
    && taskDependencies(record).includes(predecessor.TaskID)
    && dependenciesOtherThan(record, predecessor.TaskID).every((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status === 'Done'));
  if (candidates.length !== 1) return [];
  const candidate = candidates[0];
  candidate.Status = 'Blocked';
  candidate.Blocker = `Waiting for active predecessor ${predecessor.TaskID} (${predecessor.Status}).`;
  candidate.Updated = timestamp;
  appendEvidence(candidate, `${armedMarker(predecessor.TaskID)} ${timestamp}; automatic serial-lane admission.`);
  return [candidate.TaskID];
}

function disarmImmediateSuccessor(records, predecessor, timestamp, reason) {
  if (!serialLaneEnabled) return [];
  const candidates = records.filter((record) => isArmedBy(record, predecessor.TaskID));
  for (const candidate of candidates) {
    candidate.Status = 'Backlog';
    candidate.Blocker = '';
    candidate.Implementer = '';
    candidate.Updated = timestamp;
    appendEvidence(candidate, `DISARMED: ${predecessor.TaskID}; ${timestamp}; ${reason}`);
  }
  return candidates.map(({ TaskID }) => TaskID);
}

function ownerWaitStatus(record) {
  return ownerGateTaskPattern.test(record.TaskID) ? 'Awaiting Owner Gate' : 'Awaiting Owner';
}

function advanceImmediateSuccessor(records, predecessor, timestamp) {
  if (!serialLaneEnabled || predecessor.Status !== 'Done') return [];
  const candidates = records.filter((record) => (record.Status === 'Backlog' || isArmedBy(record, predecessor.TaskID))
    && taskDependencies(record).includes(predecessor.TaskID)
    && allDependenciesDone(records, record));
  if (candidates.length !== 1) return [];
  const candidate = candidates[0];
  if (isAgentTask(candidate)) {
    if (serialLaneOccupants(records, candidate.TaskID).length) return [];
    candidate.Status = 'Ready';
    candidate.Blocker = '';
    candidate.Implementer = '';
  } else {
    candidate.Status = ownerWaitStatus(candidate);
    candidate.Blocker = 'Dependencies complete; owner action is required before workflow can continue.';
  }
  candidate.Updated = timestamp;
  appendEvidence(candidate, `AUTO-ADVANCED: ${predecessor.TaskID} Done -> ${candidate.Status}; ${timestamp}; automatic serial-lane transition.`);
  return [candidate.TaskID];
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

function publicInstanceMetadata() {
  const projectName = String(instance.projectName ?? '').trim() || 'Task Tracker';
  return {
    projectId: String(instance.projectId ?? '').trim(),
    projectName,
  };
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

function requireTaskCreationColumns(header) {
  const missing = taskCreationColumns.filter((column) => !header.includes(column));
  if (!missing.length) return;
  const error = new Error(`Task creation requires the standard tracker columns. Missing: ${missing.join(', ')}.`);
  error.statusCode = 422;
  throw error;
}

function creationText(value, label, { required = false, maxLength = 4_000 } = {}) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > maxLength || /[\r\n]/.test(text)) {
    const qualifier = required ? 'is required' : 'is optional';
    const error = new Error(`${label} ${qualifier}, must be at most ${maxLength} characters and cannot contain a line break.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function newTaskRecord(header, body, timestamp) {
  const agent = reviewerIdentity(body.agent);
  const reason = creationText(body.reason, 'reason', { required: true, maxLength: 8_000 });
  const candidate = body.newTask;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    const error = new Error('newTask must be an object containing the complete planned-task contract.');
    error.statusCode = 400;
    throw error;
  }
  const taskId = safePathSegment(candidate.taskId, 'Task ID');
  const parentId = creationText(candidate.parentId, 'parentId', { maxLength: 128 });
  if (parentId) safePathSegment(parentId, 'Parent ID');
  const dependsOn = creationText(candidate.dependsOn, 'dependsOn', { maxLength: 4_000 });
  for (const dependencyId of dependsOn.split(';').map((value) => value.trim()).filter(Boolean)) safePathSegment(dependencyId, 'Dependency Task ID');
  const reviewRequired = creationText(candidate.reviewRequired, 'reviewRequired', { required: true, maxLength: 3 });
  if (!['Yes', 'No'].includes(reviewRequired)) {
    const error = new Error('reviewRequired must be exactly Yes or No.');
    error.statusCode = 400;
    throw error;
  }
  const values = {
    TaskID: taskId,
    ParentID: parentId,
    Milestone: creationText(candidate.milestone, 'milestone', { required: true, maxLength: 256 }),
    Workstream: creationText(candidate.workstream, 'workstream', { required: true, maxLength: 256 }),
    Task: creationText(candidate.task, 'task', { required: true, maxLength: 4_000 }),
    SpecRef: creationText(candidate.specRef, 'specRef', { required: true, maxLength: 4_000 }),
    DependsOn: dependsOn,
    OwnerRole: creationText(candidate.ownerRole, 'ownerRole', { required: true, maxLength: 256 }),
    Status: 'Backlog',
    Priority: creationText(candidate.priority, 'priority', { required: true, maxLength: 64 }),
    Acceptance: creationText(candidate.acceptance, 'acceptance', { required: true, maxLength: 8_000 }),
    ReviewRequired: reviewRequired,
    Blocker: '',
    Implementer: '',
    Evidence: `CREATED: ${agent} ${timestamp}; ${reason}`,
    Updated: timestamp,
    ReviewClaim: '',
    Reviewer: '',
  };
  return Object.fromEntries(header.map((column) => [column, values[column] ?? '']));
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
    if (request.method === 'GET' && requestPath === '/api/instance') {
      sendJson(response, 200, publicInstanceMetadata());
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/dependency-audit') {
      const raw = await readRawTracker();
      sendJson(response, 200, {
        revision: raw.trackerRevision,
        ...dependencyAudit(raw),
      });
      return;
    }
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
    if (request.method === 'POST' && requestPath === '/api/tasks') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        requireTaskCreationColumns(header);
        const timestamp = new Date().toISOString();
        const record = newTaskRecord(header, body, timestamp);
        if (records.some(({ TaskID }) => TaskID === record.TaskID)) {
          const error = new Error(`Task '${record.TaskID}' already exists.`);
          error.statusCode = 409;
          throw error;
        }
        records.push(record);
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === record.TaskID), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 201, result);
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
        assertSerialLaneAvailable(records, taskId);
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
        armImmediateSuccessor(records, record, timestamp);
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
        if (['blocked', 'awaiting-human'].includes(outcome)) {
          disarmImmediateSuccessor(current.records, currentRecord, timestamp, `predecessor Run closed as ${outcome}`);
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
          advanceImmediateSuccessor(records, record, timestamp);
        } else if (decision === 'blocked') {
          record.Status = 'Blocked';
          record.Blocker = reviewBlocker;
          record.ReviewClaim = '';
          disarmImmediateSuccessor(records, record, timestamp, 'predecessor review is blocked');
        } else {
          record.Status = 'Ready';
          record.Implementer = '';
          record.ReviewClaim = '';
          record.Blocker = '';
          disarmImmediateSuccessor(records, record, timestamp, 'predecessor review returned to Ready');
        }
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, reviewResult);
      return;
    }
    const contractMatch = /^\/api\/tasks\/([^/]+)\/contract$/.exec(requestPath);
    if (request.method === 'POST' && contractMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(contractMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const reason = String(body.reason ?? '').trim();
      const requestedContract = {
        Task: String(body.task ?? '').trim(),
        SpecRef: String(body.specRef ?? '').trim(),
        Acceptance: String(body.acceptance ?? '').trim(),
      };
      if (!reason || reason.length > 8_000
        || !requestedContract.Task || requestedContract.Task.length > 4_000
        || !requestedContract.SpecRef || requestedContract.SpecRef.length > 4_000
        || !requestedContract.Acceptance || requestedContract.Acceptance.length > 8_000) {
        sendJson(response, 400, { error: 'agent, reason, task, specRef and acceptance are required within their size limits.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (!['Backlog', 'Ready', 'Blocked'].includes(record.Status) || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed inactive Backlog, Ready or Blocked task can receive a contract revision. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' has active Run '${activeRun.runId}' and cannot receive a contract revision.`); error.statusCode = 409; throw error;
        }
        const changedFields = Object.entries(requestedContract)
          .filter(([field, value]) => record[field] !== value)
          .map(([field]) => field);
        if (!changedFields.length) {
          const error = new Error(`Task '${taskId}' contract is unchanged.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        Object.assign(record, requestedContract);
        record.Updated = timestamp;
        appendEvidence(record, `CONTRACT UPDATED: ${agent} ${timestamp}; fields=${changedFields.join(',')}; ${reason}`);
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const dependenciesMatch = /^\/api\/tasks\/([^/]+)\/dependencies$/.exec(requestPath);
    if (request.method === 'POST' && dependenciesMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(dependenciesMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const reason = String(body.reason ?? '').trim();
      const dependsOn = creationText(body.dependsOn, 'dependsOn', { maxLength: 4_000 });
      for (const dependencyId of dependsOn.split(';').map((value) => value.trim()).filter(Boolean)) {
        safePathSegment(dependencyId, 'Dependency Task ID');
      }
      if (!Object.hasOwn(body, 'dependsOn') || !reason || reason.length > 8_000) {
        sendJson(response, 400, { error: 'agent, reason and a complete dependsOn field are required within their size limits.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        // A closed blocked Run deliberately retains Implementer as historical
        // attribution. Only an active Run or a review claim is a live claim.
        if (!['Backlog', 'Blocked'].includes(record.Status) || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed inactive Backlog or Blocked task can receive a dependency revision. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' has active Run '${activeRun.runId}' and cannot receive a dependency revision.`); error.statusCode = 409; throw error;
        }
        if (record.DependsOn === dependsOn) {
          const error = new Error(`Task '${taskId}' dependencies are unchanged.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        const previousDependencies = record.DependsOn || '(none)';
        record.DependsOn = dependsOn;
        record.Updated = timestamp;
        appendEvidence(record, `DEPENDENCIES UPDATED: ${agent} ${timestamp}; from=${previousDependencies}; to=${dependsOn || '(none)'}; ${reason}`);
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
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
        if (record.Status !== 'Blocked' || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed ordinary Blocked task may be dependency-unblocked. ${taskId} is not eligible.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' still has active Run '${activeRun.runId}' and cannot be dependency-unblocked.`); error.statusCode = 409; throw error;
        }
        const dependencies = taskDependencies(record);
        if (!dependencies.length) { const error = new Error(`Cannot dependency-unblock ${taskId}; it has no dependencies.`); error.statusCode = 409; throw error; }
        const unfinished = dependencies.filter((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status !== 'Done');
        if (unfinished.length) { const error = new Error(`Cannot unblock ${taskId}; unfinished dependencies: ${unfinished.join(', ')}.`); error.statusCode = 409; throw error; }
        assertSerialLaneAvailable(records, taskId);
        const timestamp = new Date().toISOString();
        // A completed blocked Run may retain Implementer for historical attribution.
        // Its Run is no longer an active claim; successful maintenance clears that
        // stale attribution before exposing the task as a fresh Ready claim.
        record.Status = 'Ready'; record.Blocker = ''; record.Implementer = ''; record.Updated = timestamp;
        const line = `UNBLOCKED: ${dependencies.join(';') || 'no dependencies'}; ${timestamp}; ${agent}; ${reason}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const parkMatch = /^\/api\/tasks\/([^/]+)\/park$/.exec(requestPath);
    if (request.method === 'POST' && parkMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(parkMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const reason = String(body.reason ?? '').trim();
      if (!reason || reason.length > 8_000) {
        sendJson(response, 400, { error: 'A concrete parking reason is required within 8,000 characters.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (record.Status !== 'Blocked' || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed Blocked task can be parked. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' still has active Run '${activeRun.runId}' and cannot be parked.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        record.Status = 'Backlog'; record.Blocker = ''; record.Implementer = ''; record.Updated = timestamp;
        const line = `PARKED: Blocked -> Backlog; ${timestamp}; ${agent}; ${reason}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const admitMatch = /^\/api\/tasks\/([^/]+)\/admit$/.exec(requestPath);
    if (request.method === 'POST' && admitMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(admitMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const targetStatus = String(body.targetStatus ?? '').trim();
      const reason = String(body.reason ?? '').trim();
      const blocker = String(body.blocker ?? '').trim();
      if (!['Ready', 'Blocked'].includes(targetStatus) || !reason || reason.length > 8_000 || (targetStatus === 'Blocked' && (!blocker || blocker.length > 4_000))) {
        sendJson(response, 400, { error: 'targetStatus must be Ready or Blocked; a concrete reason is required, and Blocked also requires a concrete blocker.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (record.Status !== 'Backlog' || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed Backlog task can be admitted. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' still has active Run '${activeRun.runId}' and cannot be admitted.`); error.statusCode = 409; throw error;
        }
        const dependencies = taskDependencies(record);
        const unfinished = dependencies.filter((dependencyId) => records.find(({ TaskID }) => dependencyId === TaskID)?.Status !== 'Done');
        if (targetStatus === 'Ready' && unfinished.length) {
          const error = new Error(`Cannot admit ${taskId} as Ready; unfinished dependencies: ${unfinished.join(', ')}.`); error.statusCode = 409; throw error;
        }
        if (targetStatus === 'Ready') {
          assertSerialLaneAvailable(records, taskId);
        } else if (serialLaneEnabled) {
          const activeDependencies = dependencies.filter((dependencyId) => ['In Progress', 'In Review'].includes(records.find(({ TaskID }) => TaskID === dependencyId)?.Status));
          const otherUnfinished = dependencies.filter((dependencyId) => dependencyId !== activeDependencies[0] && records.find(({ TaskID }) => TaskID === dependencyId)?.Status !== 'Done');
          if (activeDependencies.length !== 1 || otherUnfinished.length) {
            const error = new Error(`A serial-lane Blocked admission requires exactly one active direct predecessor and all other dependencies Done. ${taskId} is not the immediate successor.`); error.statusCode = 409; throw error;
          }
        }
        const timestamp = new Date().toISOString();
        record.Status = targetStatus; record.Blocker = targetStatus === 'Blocked' ? blocker : ''; record.Implementer = ''; record.Updated = timestamp;
        const line = `ADMITTED: Backlog -> ${targetStatus}; ${timestamp}; ${agent}; ${reason}`;
        record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => taskId === TaskID), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const ownerWaitMatch = /^\/api\/tasks\/([^/]+)\/owner-wait$/.exec(requestPath);
    if (request.method === 'POST' && ownerWaitMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(ownerWaitMatch[1]), 'Task ID');
      const authorityTaskId = safePathSegment(body.authorityTaskId, 'Authority task ID');
      const agent = reviewerIdentity(body.agent);
      const ownerStatus = String(body.ownerStatus ?? '').trim();
      const reason = String(body.reason ?? '').trim();
      if (!['Awaiting Owner', 'Awaiting Owner Gate'].includes(ownerStatus) || !reason || reason.length > 8_000) {
        sendJson(response, 400, { error: 'ownerStatus must be Awaiting Owner or Awaiting Owner Gate and a concrete reason is required.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        const authority = records.find(({ TaskID }) => TaskID === authorityTaskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (!authority) { const error = new Error(`Authority task '${authorityTaskId}' was not found.`); error.statusCode = 404; throw error; }
        if (isAgentTask(record) || record.Status !== 'Backlog' || record.ReviewClaim || record.Implementer) {
          const error = new Error(`Only an unclaimed non-review Backlog task can enter an owner wait. ${taskId} is not eligible.`); error.statusCode = 409; throw error;
        }
        if (authority.Status !== 'In Progress' || authority.Implementer !== agent || !taskDependencies(record).includes(authorityTaskId)) {
          const error = new Error(`Authority task '${authorityTaskId}' must be an In Progress direct dependency claimed by '${agent}'.`); error.statusCode = 409; throw error;
        }
        const activeAuthorityRun = (await listTaskRuns(authorityTaskId)).find((run) => run.status === 'In Progress' && run.agent === agent);
        if (!activeAuthorityRun) {
          const error = new Error(`Authority task '${authorityTaskId}' has no active Run for '${agent}'.`); error.statusCode = 409; throw error;
        }
        const activeTargetRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeTargetRun) {
          const error = new Error(`Task '${taskId}' has active Run '${activeTargetRun.runId}' and cannot enter an owner wait.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        record.Status = ownerStatus;
        record.Blocker = 'Owner action is required before this task can continue.';
        record.Updated = timestamp;
        appendEvidence(record, `OWNER-WAIT ACTIVATED: ${authorityTaskId}; ${timestamp}; ${agent}; ${reason}`);
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    const ownerEvaluationMatch = /^\/api\/tasks\/([^/]+)\/owner-evaluation$/.exec(requestPath);
    if (request.method === 'POST' && ownerEvaluationMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeURIComponent(ownerEvaluationMatch[1]), 'Task ID');
      const agent = reviewerIdentity(body.agent);
      const decision = String(body.decision ?? '').trim();
      const notes = String(body.notes ?? '').trim();
      const blocker = String(body.blocker ?? '').trim();
      if (!['approved', 'blocked', 'deferred', 'return-to-owner'].includes(decision) || !notes || notes.length > 8_000 || (decision === 'blocked' && (!blocker || blocker.length > 4_000))) {
        sendJson(response, 400, { error: 'decision must be approved, blocked, deferred or return-to-owner with notes; blocked also requires a concrete blocker.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        if (record.Status !== 'Awaiting Agent Evaluation' || isAgentTask(record)) {
          const error = new Error(`Only a non-review owner task in Awaiting Agent Evaluation can be resolved. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        if (decision === 'approved') {
          record.Status = 'Done';
          record.Blocker = '';
        } else if (decision === 'blocked') {
          record.Status = 'Blocked';
          record.Blocker = blocker;
        } else if (decision === 'deferred') {
          record.Status = 'Deferred';
          record.Blocker = '';
        } else {
          record.Status = ownerWaitStatus(record);
          record.Blocker = blocker || 'Owner response requires a further explicit action.';
        }
        record.Updated = timestamp;
        appendEvidence(record, `OWNER EVALUATION ${decision}: ${agent} ${timestamp}; ${notes}`);
        if (decision === 'approved') advanceImmediateSuccessor(records, record, timestamp);
        await replaceTracker(header, records);
        const after = await readTracker();
        return { task: after.records.find(({ TaskID }) => TaskID === taskId), trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/feedback') {
      verifyMutationRequest(request);
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
    sendJson(response, error.statusCode ?? 500, {
      error: error.message ?? 'Unexpected server error.',
      ...(error.dependencyAudit ? { dependencyAudit: error.dependencyAudit } : {}),
    });
  }
});

server.listen(port, host, () => {
  const address = server.address();
  activePort = typeof address === 'object' && address ? address.port : port;
  console.log(`Task tracker is available at http://${host}:${activePort}`);
  console.log(`CSV source of truth: ${trackerPath}`);
});
