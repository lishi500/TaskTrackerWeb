#!/usr/bin/env node

import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { derivePort, nextPortInRange, parsePortNumber } from './scripts/lib/hub-port.mjs';

const toolDir = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.env.TASK_HUB_CONFIG ?? join(toolDir, 'task-hub.config.json'));
const stripBom = (text) => (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
const config = JSON.parse(stripBom(await readFile(configPath, 'utf8')));
const instance = config.instance ?? {};
const trackerPath = process.env.TRACKER_CSV
  ? resolve(process.env.TRACKER_CSV)
  : instance.tracker ? resolve(toolDir, instance.tracker) : undefined;
const publicDir = join(toolDir, 'public');
const taskRecordsDir = trackerPath ? join(dirname(trackerPath), 'task-records') : undefined;
const toolchainIssueEventsPath = trackerPath ? join(dirname(trackerPath), 'toolchain_issue_events.jsonl') : undefined;
// Reported by GET /api/health; the skill's tt.mjs carries the same number and
// scripts/test-agent-api.mjs fails if the two ever differ.
const toolVersion = '1.4.0';
const startedAt = new Date().toISOString();
// Stable id of this instance (hash of its tracker path, never the path itself)
// so a second launch can recognise "already running" without leaking locations.
const instanceId = trackerPath ? createHash('sha256').update(trackerPath.toLowerCase()).digest('hex').slice(0, 12) : '';
// Port policy: PORT env wins, then instance.port in task-hub.config.json, then a
// stable port in 4300-4999 derived from the project id, so a project keeps the
// same URL across restarts and agents never have to discover it.
function resolvePortSetting() {
  if (process.env.PORT !== undefined && process.env.PORT !== '') {
    return { port: parsePortNumber(process.env.PORT, 'PORT', { allowZero: true }), source: 'env' };
  }
  if (instance.port !== undefined && instance.port !== null && instance.port !== '') {
    return { port: parsePortNumber(instance.port, 'instance.port in task-hub.config.json'), source: 'config' };
  }
  if (String(instance.projectId ?? '').trim()) return { port: derivePort(instance.projectId), source: 'derived' };
  return { port: 4173, source: 'default' };
}
let portSetting;
try {
  portSetting = resolvePortSetting();
} catch (error) {
  console.error(`task-hub: ${error.message}`);
  process.exit(1);
}
const port = portSetting.port;
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
const ownerActionStatuses = new Set(['Awaiting Owner', 'Awaiting Owner Gate']);
const taskCreationColumns = [
  'TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef',
  'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance',
  'CompletionAuthority', 'Blocker', 'Implementer', 'Evidence', 'Updated',
  'ReviewClaim', 'Reviewer',
];
const legacyTaskCreationColumns = taskCreationColumns.map((column) => column === 'CompletionAuthority' ? 'ReviewRequired' : column);
const taskTypes = new Set(['Task', 'Bug', 'Story']);
const completionAuthorities = new Set(['IndependentReviewerAgent', 'DecisionOwner', 'NotApplicable']);
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
// Test-only: make the next N rename() calls fail with EPERM (a transient
// antivirus / indexer / reader handle on Windows) to exercise the retry loop.
let testRenameFailuresRemaining = process.env.NODE_ENV === 'test'
  ? Number(process.env.TASK_HUB_TEST_RENAME_EPERM ?? 0) || 0 : 0;

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
// Errors Windows raises while another process briefly holds a file open.
const transientFileCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
// 8 attempts, ~1.9 s in total: enough for a scanner or indexer to let go.
const renameRetryDelaysMs = [15, 30, 60, 120, 240, 480, 960];

// Atomic replace that survives short-lived handles on the destination, the
// cause of HTTP 500 on ~2% of writes under concurrent readers on Windows.
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (testRenameFailuresRemaining > 0) {
        testRenameFailuresRemaining -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM', syscall: 'rename' });
      }
      await rename(from, to);
      return;
    } catch (error) {
      if (!transientFileCodes.has(error?.code) || attempt >= renameRetryDelaysMs.length) throw error;
      console.warn(`task-hub: ${error.code} replacing ${basename(to)} (attempt ${attempt + 1}/${renameRetryDelaysMs.length + 1}); retrying`);
      await sleep(renameRetryDelaysMs[attempt]);
    }
  }
}

async function readTextWithRetry(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (!transientFileCodes.has(error?.code) || attempt >= 4) throw error;
      await sleep(15 * 2 ** attempt);
    }
  }
}

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

function taskType(record) {
  const value = String(record.TaskType ?? '').trim();
  // Existing instances are readable before the explicit schema migration. They
  // remain ordinary executable Tasks until someone explicitly classifies new work.
  return value || 'Task';
}

function isStory(record) {
  return taskType(record) === 'Story';
}

function derivedStoryStatus(records, story) {
  const children = records.filter((record) => !isStory(record) && record.ParentID === story.TaskID);
  return children.length > 0 && children.every(({ Status }) => Status === 'Done') ? 'Done' : 'Backlog';
}

// A Story is an organizational scope, so its only workflow-like signal is
// derived from its direct executable children. Keep read projections pure: a
// dashboard refresh must never write the tracker merely to correct this cache.
function projectStoryStatuses(records) {
  return records.map((record) => isStory(record)
    ? { ...record, Status: derivedStoryStatus(records, record) }
    : record);
}

function synchronizeStoryStatuses(records) {
  const timestamp = new Date().toISOString();
  for (const story of records.filter(isStory)) {
    const derivedStatus = derivedStoryStatus(records, story);
    if (story.Status === derivedStatus) continue;
    const previousStatus = story.Status || 'Unspecified';
    story.Status = derivedStatus;
    story.Updated = timestamp;
    appendEvidence(story, `STORY STATUS SYNCHRONIZED: ${previousStatus} -> ${derivedStatus}; derived from direct executable children.`);
  }
}

function completionAuthority(record) {
  const explicit = String(record.CompletionAuthority ?? '').trim();
  if (explicit) return explicit;
  if (isStory(record)) return 'NotApplicable';
  return String(record.ReviewRequired ?? '').trim().toLowerCase() === 'yes'
    ? 'IndependentReviewerAgent'
    : 'DecisionOwner';
}

function requiresIndependentReviewer(record) {
  return !isStory(record) && completionAuthority(record) === 'IndependentReviewerAgent';
}

function assertExecutableTask(record, action) {
  if (!isStory(record)) return;
  const error = new Error(`Story '${record.TaskID}' is a non-executable scope container and cannot ${action}. Create or admit a child Task or Bug instead.`);
  error.statusCode = 409;
  throw error;
}

async function readRawTracker() {
  if (!trackerPath) {
    const error = new Error('No tracker is configured. Add a project to task-hub.config.json or set TRACKER_CSV.');
    error.statusCode = 503;
    throw error;
  }
  // Excel's "CSV UTF-8" (and some editors) prepend a BOM; it would otherwise
  // glue itself to the first header cell and hide the TaskID column.
  let source;
  try {
    source = stripBom(await readTextWithRetry(trackerPath));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw httpError(503, 'The tracker CSV does not exist yet. Initialize this instance: node scripts/init-instance.mjs --project-id <id> --project-name "<name>" (add --empty for a task-free tracker).', 'tracker-missing');
    }
    throw error;
  }
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
  const hasTaskTypeSchema = header.includes('TaskType');
  const hasCompletionAuthoritySchema = header.includes('CompletionAuthority');
  if (hasCompletionAuthoritySchema && header.includes('ReviewRequired')) {
    csvErrors.push({ code: 'completion-authority-schema', message: 'task_tracker.csv cannot contain both CompletionAuthority and legacy ReviewRequired.' });
  }
  for (const [index, record] of records.entries()) {
    const explicitTaskType = String(record.TaskType ?? '').trim();
    if (hasTaskTypeSchema && !taskTypes.has(explicitTaskType)) {
      csvErrors.push({
        code: 'task-type', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
        message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) has invalid TaskType '${explicitTaskType}'.`,
      });
    }
    record.TaskType = explicitTaskType || 'Task';
    const explicitAuthority = String(record.CompletionAuthority ?? '').trim();
    if (hasCompletionAuthoritySchema && !completionAuthorities.has(explicitAuthority)) {
      csvErrors.push({
        code: 'completion-authority', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
        message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) has invalid CompletionAuthority '${explicitAuthority}'.`,
      });
    }
    record.CompletionAuthority = completionAuthority(record);
    if (explicitTaskType === 'Story'
      && (record.ParentID || taskDependencies(record).length || record.CompletionAuthority !== 'NotApplicable')) {
      csvErrors.push({
        code: 'story-structure', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
        message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) is a Story but has executable relationship fields or completion authority.`,
      });
    }
    if (hasCompletionAuthoritySchema && !isStory(record) && record.CompletionAuthority === 'NotApplicable') {
      csvErrors.push({
        code: 'completion-authority', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
        message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) is executable and cannot use CompletionAuthority 'NotApplicable'.`,
      });
    }
  }
  if (hasTaskTypeSchema) validateTypedStoryRelationships(records, csvErrors);
  return {
    header,
    records,
    trackerRevision,
    csvErrors,
  };
}

function validateTypedStoryRelationships(records, csvErrors) {
  const recordsById = new Map();
  for (const record of records) {
    const taskId = String(record.TaskID ?? '').trim();
    if (!taskId) continue;
    const matches = recordsById.get(taskId) ?? [];
    matches.push(record);
    recordsById.set(taskId, matches);
  }
  for (const [index, record] of records.entries()) {
    if (!taskTypes.has(record.TaskType) || isStory(record)) continue;
    const parentId = String(record.ParentID ?? '').trim();
    if (parentId) {
      const parents = recordsById.get(parentId) ?? [];
      if (parents.length !== 1 || !isStory(parents[0])) {
        csvErrors.push({
          code: 'story-parent', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
          message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) ParentID '${parentId}' must reference exactly one Story.`,
        });
      }
    }
    const storyDependencies = taskDependencies(record)
      .filter((dependencyId) => (recordsById.get(dependencyId) ?? []).some((dependency) => isStory(dependency)));
    if (storyDependencies.length) {
      csvErrors.push({
        code: 'story-dependency', line: index + 2, taskId: record.TaskID || '<missing TaskID>',
        dependencyIds: storyDependencies,
        message: `line ${index + 2} (${record.TaskID || '<missing TaskID>'}) cannot depend on Story: ${storyDependencies.join(', ')}.`,
      });
    }
  }
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
  // Persist the cached Story projection only as part of an authorized tracker
  // mutation. GET endpoints use projectStoryStatuses instead.
  synchronizeStoryStatuses(records);
  assertValidDependencyAudit(dependencyAudit({ header, records, csvErrors: [] }));
  const existing = await stat(trackerPath);
  const rows = [header, ...records.map((record) => header.map((name) => record[name] ?? ''))];
  const temporaryPath = `${trackerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, encodeCsv(rows), { encoding: 'utf8', mode: existing.mode });
    await renameWithRetry(temporaryPath, trackerPath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

// ---- Lock files ------------------------------------------------------------
// A lock file records its holder as { pid, host, createdAt, token }. A killed
// server used to leave a bare lock behind and every later write answered 409
// until someone deleted it by hand. Now a lock is replaced automatically when
// its holder is provably gone (same host, pid not running) or older than 120 s;
// when it is genuinely busy the 409 names the holder and how long it has held it.
const lockStaleAfterMs = 120_000;
const unreadableLockStaleAfterMs = 10_000;
const lockHostName = osHostname();
let staleLockTakeover = Promise.resolve();

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function inspectLock(lockPath) {
  let text;
  let info;
  try {
    [text, info] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  let holder;
  try { holder = JSON.parse(text); } catch { holder = undefined; }
  const readable = Number.isInteger(holder?.pid) && typeof holder?.createdAt === 'string' && !Number.isNaN(Date.parse(holder.createdAt));
  const ageMs = Date.now() - (readable ? Date.parse(holder.createdAt) : info.mtimeMs);
  let staleReason = '';
  if (!readable) {
    // Legacy empty locks (older servers) and half-written files: judge by mtime only.
    if (ageMs > unreadableLockStaleAfterMs) staleReason = 'unreadable lock file';
  } else if (ageMs > lockStaleAfterMs) {
    staleReason = 'older than 120 s';
  } else if (holder.host === lockHostName && !processIsAlive(holder.pid)) {
    staleReason = `holder pid ${holder.pid} is not running`;
  }
  return { text, ageMs, holder: readable ? holder : undefined, staleReason };
}

function lockHolderText(inspected) {
  const seconds = `${Math.max(0, Math.round(inspected.ageMs / 1000))}s ago`;
  return inspected.holder ? `pid ${inspected.holder.pid} on ${inspected.holder.host}, taken ${seconds}` : `unknown holder, created ${seconds}`;
}

async function acquireLock(lockPath, busyMessage) {
  const token = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, host: lockHostName, createdAt: new Date().toISOString(), token });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await writeFile(lockPath, payload, { flag: 'wx' });
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const inspected = await inspectLock(lockPath);
    if (!inspected) continue;
    if (!inspected.staleReason) throw httpError(409, busyMessage(lockHolderText(inspected)), 'locked');
    // Serialize takeovers inside this process and re-check right before
    // removing, so two requests can never delete each other's fresh lock.
    const takeover = staleLockTakeover.then(async () => {
      const again = await inspectLock(lockPath);
      if (again?.staleReason && again.text === inspected.text) {
        console.warn(`task-hub: replacing stale lock ${basename(lockPath)} (${again.staleReason})`);
        await unlink(lockPath).catch(() => {});
      }
    });
    staleLockTakeover = takeover.catch(() => {});
    await takeover;
  }
  throw httpError(409, busyMessage('lock is changing hands'), 'locked');
}

async function releaseLock(lockPath, token) {
  try {
    // Never remove a lock that was taken over while this holder was stuck.
    if (JSON.parse(await readFile(lockPath, 'utf8')).token !== token) return;
  } catch {
    return;
  }
  await unlink(lockPath).catch(() => {});
}

async function withFileLock(lockPath, busyMessage, action) {
  const token = await acquireLock(lockPath, busyMessage);
  try {
    return await action();
  } finally {
    await releaseLock(lockPath, token);
  }
}

async function withTrackerLock(action) {
  return withFileLock(`${trackerPath}.lock`, (holder) => `Tracker is being updated by another process (${holder}). Retry in a moment.`, action);
}

async function withToolchainIssueLock(action) {
  if (!toolchainIssueEventsPath) {
    const error = new Error('No tracker is configured for toolchain issue tracking.');
    error.statusCode = 503;
    throw error;
  }
  const lockPath = `${toolchainIssueEventsPath}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  return withFileLock(lockPath, (holder) => `Toolchain issues are being updated by another request (${holder}). Retry in a moment.`, action);
}

async function withRunLock(taskId, runId, action) {
  const lockPath = join(recordDirectory(taskId, runId), '.run.lock');
  return withFileLock(lockPath, (holder) => `Run '${runId}' is being updated by another request (${holder}). Retry in a moment.`, action);
}

function summarize(records) {
  const statusCounts = Object.groupBy(records, ({ Status }) => Status || 'Unspecified');
  const executable = records.filter((record) => !isStory(record));
  const ownerActions = executable.filter(({ Status }) => ownerActionStatuses.has(Status));
  const currentWork = executable.filter(({ Status }) => ['In Progress', 'In Review', 'Awaiting Agent Evaluation'].includes(Status));
  const dependencyWaits = executable.filter((record) => isExpectedDependencyWait(records, record));
  const blockers = executable.filter((record) => record.Status === 'Blocked' && !dependencyWaits.includes(record));
  return {
    generatedAt: new Date().toISOString(),
    total: records.length,
    executableCount: executable.length,
    storyCount: records.length - executable.length,
    statusCounts: Object.fromEntries(Object.entries(statusCounts).map(([status, tasks]) => [status, tasks.length])),
    ownerActions,
    currentWork,
    blockers,
    dependencyWaits,
  };
}

// ---- Agent-facing compact reads (GET /api/tasks, GET /api/next) ------------------
// One small object per task instead of the 19-column record with its Evidence
// log; field names match the write payloads (dependsOn is the ';'-separated string).
function compactTask(record, activeRun = null) {
  return {
    taskId: record.TaskID,
    taskType: taskType(record),
    status: record.Status,
    milestone: record.Milestone,
    parentId: record.ParentID,
    dependsOn: record.DependsOn,
    blocker: record.Blocker,
    title: record.Task,
    priority: record.Priority,
    completionAuthority: record.CompletionAuthority,
    activeRun,
  };
}

async function activeRunIds(records) {
  const ids = new Map();
  for (const record of records.filter(({ Status }) => ['In Progress', 'In Review'].includes(Status))) {
    const active = (await listTaskRuns(record.TaskID)).find((run) => run.status === 'In Progress');
    if (active) ids.set(record.TaskID, active.runId);
  }
  return ids;
}

const priorityRank = (record) => {
  const match = /^P(\d)$/i.exec(String(record.Priority ?? '').trim());
  return match ? Number(match[1]) : 9;
};

// The next claimable task, or the reason there is none (what holds the lane
// and which command moves it). Pure function of the projected records.
function nextWork(records, runIds) {
  const executable = records.filter((record) => !isStory(record));
  const byPriority = (left, right) => priorityRank(left) - priorityRank(right) || executable.indexOf(left) - executable.indexOf(right);
  const claimable = executable.filter((record) => record.Status === 'Ready' && allDependenciesDone(records, record)).sort(byPriority);
  if (claimable.length) {
    const [chosen, ...others] = claimable;
    return {
      next: { ...compactTask(chosen), acceptance: chosen.Acceptance, specRef: chosen.SpecRef },
      reason: `Ready: claim it with "tt start ${chosen.TaskID}"${others.length ? ` (${others.length} more Ready: ${others.slice(0, 5).map(({ TaskID }) => TaskID).join(', ')})` : ''}.`,
    };
  }
  const reasons = [];
  const holders = [];
  const describe = (record) => `${record.TaskID} (${record.Status})`;
  for (const record of executable.filter(({ Status }) => Status === 'In Review')) {
    holders.push({ taskId: record.TaskID, status: record.Status });
    reasons.push(`${record.TaskID} is In Review (implemented by ${record.Implementer || 'unknown'}): a different reviewer decides with: tt review ${record.TaskID} approve|reject|block "notes"`);
  }
  for (const record of executable.filter(({ Status }) => Status === 'In Progress')) {
    holders.push({ taskId: record.TaskID, status: record.Status });
    const runId = runIds.get(record.TaskID);
    reasons.push(`${record.TaskID} is In Progress${runId ? ` (Run ${runId}, agent ${record.Implementer || 'unknown'})` : ''}: finish it with: tt done ${record.TaskID}`);
  }
  const ownerWaits = executable.filter(({ Status }) => ownerActionStatuses.has(Status));
  if (ownerWaits.length) reasons.push(`Waiting for the owner: ${ownerWaits.slice(0, 5).map(describe).join(', ')}.`);
  const evaluations = executable.filter(({ Status }) => Status === 'Awaiting Agent Evaluation');
  if (evaluations.length) reasons.push(`Owner feedback needs an Agent decision: ${evaluations.slice(0, 5).map(({ TaskID }) => TaskID).join(', ')} (owner-evaluation / owner-feedback-disposition, see references/api.md).`);
  const blocked = executable.filter((record) => record.Status === 'Blocked');
  if (blocked.length) {
    const actionable = blocked.filter((record) => !isExpectedDependencyWait(records, record));
    const shown = (actionable.length ? actionable : blocked).slice(0, 3);
    reasons.push(actionable.length
      ? `Blocked: ${shown.map((record) => `${record.TaskID}${record.Blocker ? ` - ${record.Blocker.replace(/[.\s]+$/, '')}` : ''}`).join('; ')}.`
      : `Waiting on a predecessor: ${shown.map(({ TaskID }) => TaskID).join(', ')}.`);
  }
  if (!holders.length && !ownerWaits.length && !evaluations.length) {
    const backlog = executable.filter(({ Status }) => Status === 'Backlog').sort(byPriority);
    const runnable = backlog.find((record) => allDependenciesDone(records, record));
    if (runnable) {
      reasons.push(`Nothing is admitted. The next runnable Backlog task is ${runnable.TaskID}: "tt start ${runnable.TaskID}" admits and starts it.`);
    } else if (backlog.length) {
      const waiting = backlog.slice(0, 3).map((record) => `${record.TaskID} needs ${taskDependencies(record).filter((id) => records.find(({ TaskID }) => TaskID === id)?.Status !== 'Done').join(';') || 'a predecessor'}`);
      reasons.push(`Backlog tasks wait for unfinished dependencies: ${waiting.join('; ')}.`);
    } else if (!reasons.length) {
      const doneCount = executable.filter(({ Status }) => Status === 'Done').length;
      reasons.push(executable.length ? `All ${doneCount} executable task(s) are Done${doneCount === executable.length ? '' : ` (${executable.length - doneCount} in other states)`}.` : 'No executable tasks exist yet: create them with "tt import FILE" or "tt new".');
    }
  }
  return { next: null, reason: reasons.slice(0, 4).join(' | '), ...(holders.length ? { blockedBy: holders } : {}) };
}

const serialLaneStatuses = new Set(['Ready', 'In Progress', 'In Review']);

function serialLaneOccupants(records, excludedTaskId = '') {
  if (!serialLaneEnabled) return [];
  return records.filter((record) => record.TaskID !== excludedTaskId && requiresIndependentReviewer(record) && serialLaneStatuses.has(record.Status));
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
  // Evidence is append-only: an old arm marker cannot override a later blocker.
  return record.Status === 'Blocked' && !record.Implementer && !record.ReviewClaim
    && record.Evidence?.includes(armedMarker(taskId))
    && ['In Progress', 'In Review'].some((status) => record.Blocker === `Waiting for active predecessor ${taskId} (${status}).`);
}

function isExpectedDependencyWait(records, record) {
  if (record.Status !== 'Blocked' || record.Implementer || record.ReviewClaim) return false;
  const unfinished = taskDependencies(record)
    .map((id) => records.find(({ TaskID }) => TaskID === id))
    .filter((dependency) => dependency?.Status !== 'Done');
  if (unfinished.length !== 1) return false;
  const predecessor = unfinished[0];
  return predecessor && ['In Progress', 'In Review'].includes(predecessor.Status)
    && isArmedBy(record, predecessor.TaskID);
}

function appendEvidence(record, line) {
  record.Evidence = record.Evidence ? `${record.Evidence}\n${line}` : line;
}

function issueFailureKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(normalized)) {
    const error = new Error('failureKey must be a stable lowercase identifier (letters, digits, dot, underscore, colon or hyphen; 128 characters max).');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function issueText(value, label, { required = false, maxLength = 4_000, multiline = false } = {}) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > maxLength || (!multiline && /[\r\n]/.test(text))) {
    const error = new Error(`${label} ${required ? 'is required' : 'is optional'}, must be at most ${maxLength} characters${multiline ? '.' : ' and cannot contain a line break.'}`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

async function appendToolchainIssueEvent(event) {
  if (!toolchainIssueEventsPath) {
    const error = new Error('No tracker is configured for toolchain issue tracking.');
    error.statusCode = 503;
    throw error;
  }
  await mkdir(dirname(toolchainIssueEventsPath), { recursive: true });
  await appendFile(toolchainIssueEventsPath, `${JSON.stringify(event)}\n`, 'utf8');
}

function invalidToolchainIssueLog(message) {
  const error = new Error(`Toolchain issue event log is invalid: ${message}`);
  error.statusCode = 500;
  return error;
}

async function readToolchainIssueEvents() {
  if (!toolchainIssueEventsPath) {
    const error = new Error('No tracker is configured for toolchain issue tracking.');
    error.statusCode = 503;
    throw error;
  }
  let source;
  try {
    source = await readFile(toolchainIssueEventsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const events = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw invalidToolchainIssueLog(`line ${index + 1} is not JSON.`);
    }
    if (!event || typeof event !== 'object' || !['reported', 'acknowledged'].includes(event.event)) {
      throw invalidToolchainIssueLog(`line ${index + 1} has an unsupported event.`);
    }
    try {
      event.failureKey = issueFailureKey(event.failureKey);
    } catch {
      throw invalidToolchainIssueLog(`line ${index + 1} has an invalid failureKey.`);
    }
    events.push(event);
  }
  return events;
}

function summarizeToolchainIssues(events) {
  const byKey = new Map();
  for (const event of events) {
    const issue = byKey.get(event.failureKey) ?? {
      failureKey: event.failureKey,
      reports: [],
      acknowledgedReportCount: 0,
      acknowledgements: [],
    };
    if (event.event === 'reported') {
      issue.reports.push(event);
    } else {
      const count = Number(event.acknowledgedReportCount);
      if (!Number.isInteger(count) || count < issue.acknowledgedReportCount || count > issue.reports.length) {
        throw invalidToolchainIssueLog(`acknowledgement '${event.eventId ?? 'unknown'}' has an invalid report count.`);
      }
      issue.acknowledgedReportCount = count;
      issue.acknowledgements.push(event);
    }
    byKey.set(event.failureKey, issue);
  }
  return [...byKey.values()].map((issue) => {
    const latest = issue.reports.at(-1);
    const unacknowledgedCount = issue.reports.length - issue.acknowledgedReportCount;
    return {
      failureKey: issue.failureKey,
      toolchain: latest?.toolchain ?? '',
      operation: latest?.operation ?? '',
      summary: latest?.summary ?? '',
      detail: latest?.detail ?? '',
      latestEvidenceRef: latest?.evidenceRef ?? '',
      totalReportCount: issue.reports.length,
      acknowledgedReportCount: issue.acknowledgedReportCount,
      unacknowledgedCount,
      firstReportedAt: issue.reports[0]?.timestamp ?? '',
      latestReportedAt: latest?.timestamp ?? '',
      latestAcknowledgement: issue.acknowledgements.at(-1) ?? null,
      recentReports: issue.reports.slice(-3).reverse().map((report) => ({
        eventId: report.eventId,
        timestamp: report.timestamp,
        taskId: report.taskId,
        runId: report.runId ?? '',
        reporter: report.reporter,
        evidenceRef: report.evidenceRef ?? '',
      })),
    };
  }).sort((left, right) => right.unacknowledgedCount - left.unacknowledgedCount
    || String(right.latestReportedAt).localeCompare(String(left.latestReportedAt))
    || left.failureKey.localeCompare(right.failureKey));
}

function armImmediateSuccessor(records, predecessor, timestamp) {
  if (!serialLaneEnabled || !requiresIndependentReviewer(predecessor) || !['In Progress', 'In Review'].includes(predecessor.Status)) return [];
  const candidates = records.filter((record) => !isStory(record) && record.Status === 'Backlog'
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
  const candidates = records.filter((record) => !isStory(record) && (record.Status === 'Backlog' || isArmedBy(record, predecessor.TaskID))
    && taskDependencies(record).includes(predecessor.TaskID)
    && allDependenciesDone(records, record));
  if (candidates.length !== 1) return [];
  const candidate = candidates[0];
  if (requiresIndependentReviewer(candidate)) {
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

// Error carrying an HTTP status (and an optional machine-readable code that
// is returned as `code` so clients such as tt can branch without regexes).
function httpError(statusCode, message, hubCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (hubCode) error.hubCode = hubCode;
  return error;
}

// Replace absolute paths in an unexpected error message: API clients must not
// learn where the tracker lives (the full error stays in the server log).
function scrubPaths(message) {
  let text = String(message);
  const roots = [[toolDir, '<hub>'], [trackerPath ? dirname(trackerPath) : '', '<tracker>']].filter(([root]) => root);
  for (const [root, label] of roots) {
    for (const variant of new Set([root, root.replaceAll('\\', '/'), root.replaceAll('/', '\\')])) text = text.split(variant).join(label);
  }
  return text
    .replace(/[A-Za-z]:[\\/][^\s'"<>|]*/g, '<path>')
    .replace(/\\\\[^\s'"<>|]+/g, '<path>')
    .replace(/(?<![\w.:-])\/(?:[\w.-]+\/)+[\w.-]*/g, '<path>');
}

// What an API client may see for a failure. Errors we raise ourselves
// (statusCode set) are written for clients. Anything else is unexpected: show
// the system error code (clients retry on EPERM/EBUSY) but never raw paths.
function publicErrorMessage(error) {
  if (error?.statusCode) return String(error.message);
  const code = /^E[A-Z0-9]+$/.test(String(error?.code ?? '')) ? error.code : '';
  if (code) {
    const advice = transientFileCodes.has(code) ? ' Another program (antivirus, indexer, editor) is holding a tracker file; retry in a moment.' : '';
    return `${code}: the tracker could not complete a file operation${error.syscall ? ` (${error.syscall})` : ''}.${advice}`;
  }
  return scrubPaths(error?.message || 'Unexpected server error.');
}

// A request target is always a path. new URL('//x', base) would read it as a
// protocol-relative reference (host "x"), so leading slashes are collapsed.
function parseRequestUrl(request) {
  const target = String(request.url ?? '/').replace(/^\/{2,}/, '/');
  try {
    return new URL(target, 'http://tracker.invalid');
  } catch {
    throw httpError(400, 'Malformed request URL.', 'bad-url');
  }
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

// ---- Local-only request guards ----------------------------------------------
const loopbackNames = new Set(['127.0.0.1', 'localhost', '[::1]']);
const bindIsLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host) || /^127\./.test(host);

// The page may be opened as 127.0.0.1, localhost or [::1]; browsers send the
// exact spelling as Origin, so every loopback alias of this port is the same
// origin for our purposes.
function allowedOrigins() {
  const origins = [`http://127.0.0.1:${activePort}`, `http://localhost:${activePort}`, `http://[::1]:${activePort}`];
  const configured = `http://${host}:${activePort}`;
  if (!origins.includes(configured)) origins.push(configured);
  return origins;
}

// DNS-rebinding guard: while bound to loopback, only loopback names may be
// used to address the tracker. A rebound hostname (evil.example -> 127.0.0.1)
// would otherwise be same-origin for the attacker's page and for our Origin check.
function assertAllowedHost(request) {
  if (!bindIsLoopback) return;
  const raw = String(request.headers.host ?? '');
  let name = '';
  try { name = new URL(`http://${raw}`).hostname; } catch { /* rejected below */ }
  if (loopbackNames.has(name) || name === host) return;
  throw httpError(403, `Host '${raw.slice(0, 80)}' is not allowed: this tracker only answers requests addressed to 127.0.0.1, localhost or [::1].`, 'host');
}

function verifyMutationRequest(request) {
  const contentType = request.headers['content-type'] ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw httpError(415, 'Mutation requests must use Content-Type: application/json.', 'content-type');
  }
  const origins = allowedOrigins();
  const origin = request.headers.origin;
  if (!origin) {
    throw httpError(403, `Origin header is missing: send "Origin: ${origins[0]}" with every POST (tt and the dashboard do this automatically).`, 'origin');
  }
  if (!origins.includes(origin)) {
    throw httpError(403, `Origin '${String(origin).slice(0, 100)}' is not allowed; mutation requests must come from this tracker: ${origins.join(', ')}.`, 'origin');
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 196_608) throw httpError(413, 'Request body is limited to 192 KB.', 'body-too-large');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw httpError(400, 'Request body is empty: send a JSON object.', 'bad-body');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw httpError(400, 'Request body is not valid UTF-8 (a console code page probably re-encoded it, e.g. curl.exe -d or Invoke-RestMethod in PowerShell 5.1). Send the JSON from a UTF-8 file or from Node fetch.', 'bad-encoding');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw httpError(400, `Request body must be valid JSON (${String(error.message).slice(0, 100)}).`, 'bad-json');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw httpError(400, 'Request body must be a JSON object, for example {"trackerRevision":"...","agent":"claude"}.', 'bad-body');
  }
  return value;
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError(400, 'Malformed %-encoding in the URL path.', 'bad-url');
  }
}

function taskDependencies(record) {
  return String(record.DependsOn ?? '').split(';').map((value) => value.trim()).filter(Boolean);
}

function requireTaskCreationColumns(header) {
  const missing = taskCreationColumns.filter((column) => !header.includes(column));
  if (!missing.length) return;
  const hints = [];
  if (missing.includes('TaskType')) hints.push('Run POST /api/tracker/task-types/migrate first for an existing tracker.');
  if (missing.includes('CompletionAuthority') && header.includes('ReviewRequired')) hints.push('Run POST /api/tracker/completion-authority/migrate to replace legacy ReviewRequired.');
  const migrationHint = hints.length ? ` ${hints.join(' ')}` : '';
  const error = new Error(`Task creation requires the standard tracker columns. Missing: ${missing.join(', ')}.${migrationHint}`);
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

function requestedTaskType(value) {
  const selected = creationText(value, 'taskType', { required: true, maxLength: 16 });
  if (!taskTypes.has(selected)) {
    const error = new Error('taskType must be exactly Task, Bug or Story.');
    error.statusCode = 400;
    throw error;
  }
  return selected;
}

function requestedCompletionAuthority(value) {
  const selected = creationText(value, 'completionAuthority', { required: true, maxLength: 64 });
  if (!completionAuthorities.has(selected)) {
    const error = new Error('completionAuthority must be IndependentReviewerAgent, DecisionOwner or NotApplicable.');
    error.statusCode = 400;
    throw error;
  }
  return selected;
}

// DependsOn is one string of TaskIDs separated by ';'. Agents often send
// "A,B" or "A B"; say so instead of a generic id-character error.
function parseDependsOn(value) {
  return String(value ?? '').split(';').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (/[,\s]/.test(entry)) {
      throw httpError(400, `dependsOn entry '${entry.slice(0, 60)}' is not a TaskID. Separate multiple dependencies with ';' (for example "T-001;T-002"), not with commas or spaces.`, 'invalid-dependency');
    }
    return safePathSegment(entry, 'Dependency Task ID');
  });
}

function assertKnownDependencies(records, dependencyIds, ownTaskId) {
  if (dependencyIds.includes(ownTaskId)) {
    throw httpError(422, `Task '${ownTaskId}' cannot depend on itself (self dependency).`, 'invalid-dependency');
  }
  const unknown = dependencyIds.filter((dependencyId) => !records.some(({ TaskID }) => TaskID === dependencyId));
  if (unknown.length) {
    throw httpError(422, `Unknown dependency TaskID(s): ${unknown.join(', ')}. dependsOn is a ';'-separated list of existing TaskIDs (list them with GET /api/tasks).`, 'unknown-dependency');
  }
}

function assertPlannedTaskRelationships(records, { taskId, taskType: selectedType, parentId, dependsOn, completionAuthority: selectedAuthority }) {
  const dependencies = parseDependsOn(dependsOn);
  if (selectedType === 'Story') {
    if (parentId || dependencies.length || selectedAuthority !== 'NotApplicable') {
      const error = new Error('Story is a non-executable scope container: it cannot have ParentID or DependsOn and must use completionAuthority=NotApplicable.');
      error.statusCode = 422;
      throw error;
    }
    return;
  }
  if (selectedAuthority === 'NotApplicable') {
    const error = new Error('Task and Bug must use completionAuthority=IndependentReviewerAgent or DecisionOwner.');
    error.statusCode = 422;
    throw error;
  }
  if (parentId) {
    const parent = records.find(({ TaskID }) => TaskID === parentId);
    if (!parent) {
      const error = new Error(`Parent Story '${parentId}' was not found.`);
      error.statusCode = 422;
      throw error;
    }
    if (!isStory(parent)) {
      const error = new Error(`Parent '${parentId}' must have TaskType Story; ${parentId} is ${taskType(parent)}.`);
      error.statusCode = 422;
      throw error;
    }
  }
  assertKnownDependencies(records, dependencies, taskId);
  const storyDependencies = dependencies.filter((dependencyId) => {
    const dependency = records.find(({ TaskID }) => TaskID === dependencyId);
    return dependency && isStory(dependency);
  });
  if (storyDependencies.length) {
    const error = new Error(`Story is organizational only and cannot be used as DependsOn: ${storyDependencies.join(', ')}.`);
    error.statusCode = 422;
    throw error;
  }
}

function newTaskRecord(header, body, timestamp, records) {
  const agent = identityField(body.agent, 'agent');
  const reason = creationText(body.reason, 'reason', { required: true, maxLength: 8_000 });
  const candidate = body.newTask;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    const error = new Error('newTask must be an object containing the complete planned-task contract.');
    error.statusCode = 400;
    throw error;
  }
  const taskId = safePathSegment(candidate.taskId, 'Task ID');
  const selectedType = requestedTaskType(candidate.taskType);
  const parentId = creationText(candidate.parentId, 'parentId', { maxLength: 128 });
  if (parentId) safePathSegment(parentId, 'Parent ID');
  const dependsOn = creationText(candidate.dependsOn, 'dependsOn', { maxLength: 4_000 });
  const selectedAuthority = requestedCompletionAuthority(candidate.completionAuthority);
  assertPlannedTaskRelationships(records, { taskId, taskType: selectedType, parentId, dependsOn, completionAuthority: selectedAuthority });
  const values = {
    TaskID: taskId,
    TaskType: selectedType,
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
    CompletionAuthority: selectedAuthority,
    Blocker: '',
    Implementer: '',
    Evidence: `CREATED: ${agent} ${timestamp}; ${reason}`,
    Updated: timestamp,
    ReviewClaim: '',
    Reviewer: '',
  };
  return Object.fromEntries(header.map((column) => [column, values[column] ?? '']));
}

// Windows cannot create a file or folder named after a legacy device, with or
// without an extension (CON, nul.txt, COM1.x ...). Task and Run ids become
// folder names under tracker/task-records, so they must not look like one.
const windowsReservedNames = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function safePathSegment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw httpError(400, `${label} is required.`, 'invalid-id');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(normalized)) {
    throw httpError(400, `${label} must use only letters, digits, dot, underscore or hyphen, at most 128 characters (got '${normalized.slice(0, 40)}').`, 'invalid-id');
  }
  if (/^\.+$/.test(normalized) || normalized.endsWith('.')) {
    throw httpError(400, `${label} '${normalized}' cannot consist only of dots or end with '.': Windows cannot store such a folder name.`, 'invalid-id');
  }
  if (windowsReservedNames.test(normalized)) {
    throw httpError(400, `${label} '${normalized}' is a reserved Windows device name (CON PRN AUX NUL COM1-9 LPT1-9); choose another id, for example '${normalized}-1'.`, 'invalid-id');
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
    await renameWithRetry(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

// readRun() surfaces ENOENT unchanged (claim recovery relies on that); API
// handlers use these two wrappers to answer 404 instead of a raw filesystem error.
async function readRunOrNotFound(taskId, runId) {
  try {
    return await readRun(taskId, runId);
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(404, `Run '${runId}' was not found for task '${taskId}'.`, 'run-not-found');
    throw error;
  }
}

async function assertRunExists(taskId, runId) {
  try {
    await stat(join(recordDirectory(taskId, runId), 'run.json'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw httpError(404, `Run '${runId}' was not found for task '${taskId}'.`, 'run-not-found');
    throw error;
  }
}

// Artifacts are agent-authored: HTML, SVG and XML are served as plain text so a
// stored file can never execute with the dashboard's origin.
function artifactContentType(path) {
  const extension = extname(path).toLowerCase();
  if (['.html', '.htm', '.xhtml', '.svg', '.xml'].includes(extension)) return 'text/plain; charset=utf-8';
  return mimeTypes[extension] ?? 'text/plain; charset=utf-8';
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
    await renameWithRetry(temporaryPath, path);
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
    await renameWithRetry(temporaryPath, path);
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
  if (!requested) {
    throw httpError(400, 'trackerRevision is required: read the current value from GET /api/health (or any packet or list response) and send it in the JSON body.', 'revision-required');
  }
  if (requested !== trackerRevision) {
    throw httpError(409, `trackerRevision is stale (current: ${trackerRevision}). Re-read it from GET /api/health and retry.`, 'revision-stale');
  }
}

function packetFor(record, records, runs, trackerRevision) {
  const projectedRecords = projectStoryStatuses(records);
  const projectedRecord = projectedRecords.find(({ TaskID }) => TaskID === record.TaskID);
  const dependencies = taskDependencies(projectedRecord).map((taskId) => {
    const dependency = projectedRecords.find(({ TaskID }) => TaskID === taskId);
    return dependency ? {
      taskId,
      status: dependency.Status,
      acceptance: dependency.Acceptance,
      evidence: dependency.Evidence,
      specRef: dependency.SpecRef,
    } : { taskId, missing: true };
  });
  const reverseDependencies = projectedRecords
    .filter((candidate) => taskDependencies(candidate).includes(projectedRecord.TaskID))
    .map((candidate) => ({ taskId: candidate.TaskID, status: candidate.Status, task: candidate.Task }));
  const scopeSummary = (item) => ({
    taskId: item.TaskID, taskType: taskType(item), goal: item.Task,
    acceptance: item.Acceptance, specRef: item.SpecRef, milestone: item.Milestone,
  });
  const story = projectedRecords.find((candidate) => candidate.TaskID === projectedRecord.ParentID && isStory(candidate));
  return {
    trackerRevision,
    task: projectedRecord,
    packet: {
      goal: projectedRecord.Task,
      nonGoals: 'Task-specific exclusions are in SpecRef and the Story scope when present; no separate non-goals field is stored. A Story does not authorize work outside this task contract.',
      acceptance: projectedRecord.Acceptance,
      specRef: projectedRecord.SpecRef,
      blocker: projectedRecord.Blocker,
      availability: projectedRecord.Status,
      dependencies,
      reverseDependencies,
      existingRuns: runs,
      context: {
        story: story ? scopeSummary(story) : null,
        children: isStory(projectedRecord) ? projectedRecords.filter((candidate) => !isStory(candidate) && candidate.ParentID === projectedRecord.TaskID)
          .map((candidate) => ({ ...scopeSummary(candidate), status: candidate.Status })) : [],
      },
    },
  };
}

function parseRunPath(requestPath) {
  const match = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)\/(events|artifacts|close)$/.exec(requestPath);
  return match ? {
    taskId: decodeSegment(match[1]),
    runId: decodeSegment(match[2]),
    operation: match[3],
  } : undefined;
}

// Identity comparison used for review independence: trim, Unicode-compatibility
// fold (full-width letters), lower-case, collapse inner whitespace.
function normalizeIdentity(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Name inside "REVIEW-CLAIM: <reviewer> <ISO timestamp>" (names may contain spaces).
function reviewClaimant(claim) {
  return /^REVIEW-CLAIM: (.+) \d{4}-\d{2}-\d{2}T\S+$/.exec(String(claim ?? ''))?.[1] ?? '';
}

// Acting identity (agent / reviewer / actor / reporter / acknowledger). The
// error names the field that was actually missing.
function identityField(value, name) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw httpError(400, `${name} is required: send the acting agent's name (for example "claude") in the JSON body.`, 'identity-required');
  }
  if (text.length > 256 || /[\r\n]/.test(text)) {
    throw httpError(400, `${name} must be at most 256 characters and cannot contain a line break.`, 'identity-invalid');
  }
  return text;
}

// True when `candidate` is strictly inside `directory`. Separator- and
// platform-aware: resolve() returns backslashes on Windows, so a literal "/"
// prefix test rejected every asset there (dashboard rendered unstyled).
function isInsideDirectory(directory, candidate) {
  const fromDirectory = relative(directory, candidate);
  return fromDirectory !== '' && fromDirectory !== '..' && !fromDirectory.startsWith(`..${sep}`) && !isAbsolute(fromDirectory);
}

async function serveStatic(requestPath, response) {
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = resolve(publicDir, relativePath);
  if (!isInsideDirectory(publicDir, filePath)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(filePath)).isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    response.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The dashboard is one module script plus one stylesheet: nothing inline, nothing remote.
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = parseRequestUrl(request);
    const requestPath = requestUrl.pathname;
    assertAllowedHost(request);
    if (request.method === 'GET' && requestPath === '/api/instance') {
      sendJson(response, 200, publicInstanceMetadata());
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/health') {
      // Always 200 while the server is up; `ok` says whether the tracker itself is usable.
      let trackerRevision = null;
      let trackerError = '';
      try {
        const raw = await readRawTracker();
        trackerRevision = raw.trackerRevision;
        const audit = dependencyAudit(raw);
        if (!audit.valid) trackerError = dependencyAuditMessage(audit).slice(0, 400);
      } catch (error) {
        trackerError = publicErrorMessage(error);
      }
      sendJson(response, 200, {
        ok: !trackerError,
        tool: 'task-hub',
        toolVersion,
        ...publicInstanceMetadata(),
        trackerRevision,
        serialLane: serialLaneEnabled,
        startedAt,
        pid: process.pid,
        instanceId,
        ...(trackerError ? { trackerError } : {}),
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/tasks') {
      const supported = ['status', 'milestone', 'type', 'parent', 'limit'];
      for (const key of requestUrl.searchParams.keys()) {
        if (!supported.includes(key)) throw httpError(400, `Unknown query parameter '${key.slice(0, 40)}'. Supported: ${supported.join(', ')}.`, 'bad-query');
      }
      const fold = (value) => String(value ?? '').trim().toLowerCase();
      const statuses = requestUrl.searchParams.get('status') === null ? null : requestUrl.searchParams.get('status').split(',').map(fold).filter(Boolean);
      const milestone = requestUrl.searchParams.get('milestone') === null ? null : fold(requestUrl.searchParams.get('milestone'));
      const typeFilter = requestUrl.searchParams.get('type') === null ? null : fold(requestUrl.searchParams.get('type'));
      const parent = requestUrl.searchParams.get('parent');
      if (typeFilter !== null && !['task', 'bug', 'story'].includes(typeFilter)) throw httpError(400, `type must be Task, Bug or Story (got '${typeFilter.slice(0, 20)}').`, 'bad-query');
      const limitText = requestUrl.searchParams.get('limit');
      const limit = limitText === null ? 500 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2_000) throw httpError(400, 'limit must be an integer between 1 and 2000.', 'bad-query');
      const { records, trackerRevision } = await readTracker();
      const matching = projectStoryStatuses(records).filter((record) => (statuses === null || statuses.includes(fold(record.Status)))
        && (milestone === null || fold(record.Milestone) === milestone)
        && (typeFilter === null || fold(taskType(record)) === typeFilter)
        && (parent === null || record.ParentID === parent));
      const shown = matching.slice(0, limit);
      const runIds = await activeRunIds(shown);
      sendJson(response, 200, {
        trackerRevision,
        total: matching.length,
        count: shown.length,
        truncated: shown.length < matching.length,
        tasks: shown.map((record) => compactTask(record, runIds.get(record.TaskID) ?? null)),
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/next') {
      const { records, trackerRevision } = await readTracker();
      const projected = projectStoryStatuses(records);
      sendJson(response, 200, { trackerRevision, ...nextWork(projected, await activeRunIds(projected)) });
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
      const projectedRecords = projectStoryStatuses(records);
      sendJson(response, 200, {
        revision: trackerRevision,
        records: projectedRecords.map((record) => ({ ...record, RunSummary: summaries.get(record.TaskID) ?? null })),
      });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/summary') {
      const { records, trackerRevision } = await readTracker();
      sendJson(response, 200, { ...summarize(projectStoryStatuses(records)), revision: trackerRevision });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/toolchain-issues') {
      const issues = summarizeToolchainIssues(await readToolchainIssueEvents());
      const includeAcknowledged = requestUrl.searchParams.get('includeAcknowledged') === 'true';
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        issues: includeAcknowledged ? issues : issues.filter(({ unacknowledgedCount }) => unacknowledgedCount > 0),
        totalIssueCount: issues.length,
        activeIssueCount: issues.filter(({ unacknowledgedCount }) => unacknowledgedCount > 0).length,
      });
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/tracker/task-types/migrate') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const actor = identityField(body.actor, 'actor');
      const reason = creationText(body.reason, 'reason', { required: true, maxLength: 8_000 });
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        if (header.includes('TaskType')) {
          const error = new Error('TaskType is already present; no schema migration is needed.');
          error.statusCode = 409;
          throw error;
        }
        const legacyColumns = legacyTaskCreationColumns.filter((column) => column !== 'TaskType');
        const missing = legacyColumns.filter((column) => !header.includes(column));
        if (missing.length) {
          const error = new Error(`Task type migration requires the legacy standard tracker columns. Missing: ${missing.join(', ')}.`);
          error.statusCode = 422;
          throw error;
        }
        const taskIdIndex = header.indexOf('TaskID');
        const migratedHeader = [...header];
        migratedHeader.splice(taskIdIndex + 1, 0, 'TaskType');
        const timestamp = new Date().toISOString();
        for (const record of records) {
          const legacyParentId = String(record.ParentID ?? '').trim();
          record.TaskType = 'Task';
          record.ParentID = '';
          record.Updated = timestamp;
          appendEvidence(record, `TASK TYPE SCHEMA MIGRATED: ${actor} ${timestamp}; default=Task; ${reason}`);
          if (legacyParentId) appendEvidence(record, `LEGACY PARENTID RETAINED AS HISTORY: ${legacyParentId}; not interpreted as a Story relationship.`);
        }
        await replaceTracker(migratedHeader, records);
        const after = await readTracker();
        return { records: after.records, trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/tracker/completion-authority/migrate') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const actor = identityField(body.actor, 'actor');
      const reason = creationText(body.reason, 'reason', { required: true, maxLength: 8_000 });
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        if (header.includes('CompletionAuthority')) {
          const error = new Error('CompletionAuthority is already present; no schema migration is needed.');
          error.statusCode = 409;
          throw error;
        }
        if (!header.includes('TaskType') || !header.includes('ReviewRequired')) {
          const error = new Error('Completion authority migration requires TaskType and legacy ReviewRequired. Run the task-type migration first when needed.');
          error.statusCode = 422;
          throw error;
        }
        const reviewRequiredIndex = header.indexOf('ReviewRequired');
        const migratedHeader = [...header];
        migratedHeader[reviewRequiredIndex] = 'CompletionAuthority';
        const timestamp = new Date().toISOString();
        for (const record of records) {
          const legacyReviewRequired = String(record.ReviewRequired ?? '').trim();
          const authority = isStory(record)
            ? 'NotApplicable'
            : legacyReviewRequired.toLowerCase() === 'yes' ? 'IndependentReviewerAgent' : 'DecisionOwner';
          record.CompletionAuthority = authority;
          record.Updated = timestamp;
          appendEvidence(record, `COMPLETION AUTHORITY SCHEMA MIGRATED: ${actor} ${timestamp}; ReviewRequired=${legacyReviewRequired || '(blank)'} -> ${authority}; ${reason}`);
        }
        await replaceTracker(migratedHeader, records);
        const after = await readTracker();
        return { records: after.records, trackerRevision: after.trackerRevision };
      });
      sendJson(response, 200, result);
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/toolchain-issues') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(body.taskId, 'Task ID');
      const runId = String(body.runId ?? '').trim();
      if (runId) safePathSegment(runId, 'Run ID');
      const failureKey = issueFailureKey(body.failureKey);
      const reporter = identityField(body.reporter, 'reporter');
      const toolchain = issueText(body.toolchain, 'toolchain', { required: true, maxLength: 128 });
      const operation = issueText(body.operation, 'operation', { required: true, maxLength: 512 });
      const summary = issueText(body.summary, 'summary', { required: true, maxLength: 2_000 });
      const detail = issueText(body.detail, 'detail', { maxLength: 8_000, multiline: true });
      const evidenceRef = issueText(body.evidenceRef, 'evidenceRef', { maxLength: 512 });
      const { records } = await readTracker();
      if (!records.some(({ TaskID }) => TaskID === taskId)) {
        const error = new Error(`Task '${taskId}' was not found.`);
        error.statusCode = 404;
        throw error;
      }
      if (runId && !(await listTaskRuns(taskId)).some((run) => run.runId === runId)) {
        const error = new Error(`Run '${runId}' was not found for task '${taskId}'.`);
        error.statusCode = 404;
        throw error;
      }
      const result = await withToolchainIssueLock(async () => {
        const event = {
          eventId: randomUUID(),
          event: 'reported',
          timestamp: new Date().toISOString(),
          failureKey,
          taskId,
          ...(runId ? { runId } : {}),
          reporter,
          toolchain,
          operation,
          summary,
          ...(detail ? { detail } : {}),
          ...(evidenceRef ? { evidenceRef } : {}),
        };
        await appendToolchainIssueEvent(event);
        const issue = summarizeToolchainIssues(await readToolchainIssueEvents()).find((candidate) => candidate.failureKey === failureKey);
        return { event, issue };
      });
      sendJson(response, 201, result);
      return;
    }
    const issueAckMatch = /^\/api\/toolchain-issues\/([^/]+)\/ack$/.exec(requestPath);
    if (request.method === 'POST' && issueAckMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const failureKey = issueFailureKey(decodeSegment(issueAckMatch[1]));
      const acknowledger = identityField(body.acknowledger, 'acknowledger');
      const notes = issueText(body.notes, 'notes', { required: true, maxLength: 4_000, multiline: true });
      const expectedReportCount = body.expectedReportCount;
      if (!Number.isSafeInteger(expectedReportCount) || expectedReportCount < 1) {
        sendJson(response, 400, { error: 'expectedReportCount must be the positive totalReportCount from the issue you inspected.' });
        return;
      }
      const result = await withToolchainIssueLock(async () => {
        const issues = summarizeToolchainIssues(await readToolchainIssueEvents());
        const issue = issues.find((candidate) => candidate.failureKey === failureKey);
        if (!issue) {
          const error = new Error(`Toolchain issue '${failureKey}' was not found.`);
          error.statusCode = 404;
          throw error;
        }
        if (issue.totalReportCount !== expectedReportCount) {
          const error = new Error('Toolchain issue has changed. Reload and inspect its new reports before acknowledging.');
          error.statusCode = 409;
          throw error;
        }
        if (issue.unacknowledgedCount === 0) {
          const error = new Error(`Toolchain issue '${failureKey}' has no new reports to acknowledge.`);
          error.statusCode = 409;
          throw error;
        }
        const event = {
          eventId: randomUUID(),
          event: 'acknowledged',
          timestamp: new Date().toISOString(),
          failureKey,
          acknowledgedReportCount: issue.totalReportCount,
          acknowledger,
          notes,
        };
        await appendToolchainIssueEvent(event);
        const acknowledged = summarizeToolchainIssues(await readToolchainIssueEvents()).find((candidate) => candidate.failureKey === failureKey);
        return { event, issue: acknowledged };
      });
      sendJson(response, 200, result);
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
        const record = newTaskRecord(header, body, timestamp, records);
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
      const taskId = decodeSegment(packetMatch[1]);
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
      const taskId = safePathSegment(decodeSegment(runsMatch[1]), 'Task ID');
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
      const taskId = safePathSegment(decodeSegment(artifactReadMatch[1]), 'Task ID');
      const runId = safePathSegment(decodeSegment(artifactReadMatch[2]), 'Run ID');
      const artifact = artifactPath(taskId, runId, decodeSegment(artifactReadMatch[3]));
      let artifactInfo;
      try {
        artifactInfo = await stat(artifact.path);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      }
      if (!artifactInfo?.isFile()) {
        throw httpError(404, `Artifact '${artifact.name}' was not found in Run '${runId}' (list artifacts with GET /api/tasks/${taskId}/runs/${runId}).`, 'artifact-not-found');
      }
      // Agent-written files are served from the dashboard's origin: never as
      // active content (HTML/SVG/XML would run script with our Origin).
      response.writeHead(200, {
        'Content-Type': artifactContentType(artifact.path),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      });
      createReadStream(artifact.path).on('error', () => response.destroy()).pipe(response);
      return;
    }
    const runDetailMatch = /^\/api\/tasks\/([^/]+)\/runs\/([^/]+)$/.exec(requestPath);
    if (request.method === 'GET' && runDetailMatch) {
      const taskId = safePathSegment(decodeSegment(runDetailMatch[1]), 'Task ID');
      const runId = safePathSegment(decodeSegment(runDetailMatch[2]), 'Run ID');
      const run = await readRunOrNotFound(taskId, runId);
      sendJson(response, 200, { run: await runForDisplay(run), events: await readRunEvents(taskId, runId) });
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/runs/start') {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(body.taskId, 'taskId');
      const agent = String(body.agent ?? '').trim();
      const verificationProfile = String(body.verificationProfile ?? '').trim();
      const scope = String(body.scope ?? '').trim();
      const expectedBehavior = String(body.expectedBehavior ?? '').trim();
      const missingRunFields = Object.entries({ agent, verificationProfile, scope, expectedBehavior }).filter(([, value]) => !value).map(([name]) => name);
      if (missingRunFields.length) {
        throw httpError(400, `Missing required field(s): ${missingRunFields.join(', ')}. POST /api/runs/start needs taskId, trackerRevision, agent, verificationProfile, scope and expectedBehavior as non-empty strings.`, 'missing-field');
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
        assertExecutableTask(record, 'start a managed Run');
        if (record.Status !== 'Ready') {
          const error = new Error(`Only Ready tasks can start a managed Run. ${taskId} is '${record.Status}'.`);
          error.statusCode = 409;
          throw error;
        }
        if (requiresIndependentReviewer(record)) assertSerialLaneAvailable(records, taskId);
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
      await assertRunExists(taskId, runId);
      if (runPath.operation === 'events') {
        const type = String(body.type ?? '').trim();
        const result = String(body.result ?? '').trim();
        const message = String(body.message ?? '').trim();
        const missingEventFields = Object.entries({ type, result, message }).filter(([, value]) => !value).map(([name]) => name);
        if (missingEventFields.length) {
          throw httpError(400, `Missing required field(s): ${missingEventFields.join(', ')}. An event needs trackerRevision, type, result and message (each at most 8,000 characters).`, 'missing-field');
        }
        if ([type, result, message].some((value) => value.length > 8_000)) {
          throw httpError(400, 'type, result and message are limited to 8,000 characters each.', 'field-too-long');
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
        if (!requestedName) throw httpError(400, 'Missing required field: name. An artifact needs trackerRevision, name (a safe relative path such as evidence.md or logs/editor.log) and content (text, at most 128 KB).', 'missing-field');
        if (!content) throw httpError(400, 'Missing required field: content. Artifacts are text, at most 128 KB; reference large or binary evidence by repository path or HTTPS URL inside an evidence artifact.', 'missing-field');
        if (byteLength > maxArtifactBytes) throw httpError(400, `Artifact content is ${byteLength} bytes; the limit is 128 KB (${maxArtifactBytes} bytes). Trim it or store the large file in the repository and reference its path.`, 'artifact-too-large');
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
      if (!['verified', 'blocked', 'awaiting-human', 'incomplete'].includes(outcome)) {
        throw httpError(400, `outcome must be verified, blocked, awaiting-human or incomplete${outcome ? ` (got '${outcome.slice(0, 40)}')` : ' (missing)'}.`, 'invalid-field');
      }
      if (!summary) throw httpError(400, 'summary is required: one or two sentences saying what was done and verified.', 'missing-field');
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
        if (outcome === 'verified' && !requiresIndependentReviewer(currentRecord)) {
          const error = new Error(`Only IndependentReviewerAgent work can close as verified. ${taskId} must return to an owner-facing status for a DecisionOwner decision.`);
          error.statusCode = 409;
          throw error;
        }
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
      const taskId = safePathSegment(decodeSegment(reviewMatch[1]), 'Task ID');
      await recoverTaskPendingCloses(taskId);
      const action = String(body.action ?? '').trim();
      const reviewer = identityField(body.reviewer, 'reviewer');
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
        assertExecutableTask(record, 'be reviewed');
        if (!requiresIndependentReviewer(record)) {
          const error = new Error(`Only IndependentReviewerAgent work can be independently reviewed. ${taskId} uses ${completionAuthority(record)}.`);
          error.statusCode = 409;
          throw error;
        }
        if (record.Status !== 'In Review') {
          const error = new Error(`Only In Review tasks can be reviewed. ${taskId} is '${record.Status}'.`);
          error.statusCode = 409;
          throw error;
        }
        const taskRuns = await listTaskRuns(taskId);
        const activeRun = taskRuns.find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' has unresolved active Run '${activeRun.runId}' and cannot be reviewed.`);
          error.statusCode = 409;
          throw error;
        }
        if (!record.Implementer) {
          throw httpError(409, `Reviewer must be distinct from the task Implementer, but '${taskId}' has no recorded Implementer to compare with.`, 'reviewer-not-independent');
        }
        // Independence is judged on normalized names (trim, case, whitespace) against
        // the current Implementer and every agent that held a Run on this task, so
        // "IMPL-LOCK" cannot review the work of "impl-lock". Abandoned claims never
        // produced work and do not count.
        const implementerNames = [record.Implementer, ...taskRuns.filter((run) => run.status !== 'Abandoned').map((run) => run.agent)].filter(Boolean);
        const matchingImplementer = implementerNames.find((name) => normalizeIdentity(name) === normalizeIdentity(reviewer));
        if (matchingImplementer) {
          throw httpError(409, `Reviewer must be distinct from the task Implementer and every agent that held a Run on it: '${reviewer}' matches '${matchingImplementer}' (names are compared ignoring case and extra spaces). Review with a different name.`, 'reviewer-not-independent');
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
        if (!record.ReviewClaim || normalizeIdentity(reviewClaimant(record.ReviewClaim)) !== normalizeIdentity(reviewer)) {
          const claimant = reviewClaimant(record.ReviewClaim);
          const error = new Error(claimant
            ? `Reviewer '${reviewer}' has not claimed task '${taskId}'; the open claim belongs to '${claimant}'.`
            : `Reviewer '${reviewer}' has not claimed task '${taskId}'; send action "claim" first.`);
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
      const taskId = safePathSegment(decodeSegment(contractMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
      const taskId = safePathSegment(decodeSegment(dependenciesMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
      const reason = String(body.reason ?? '').trim();
      const dependsOn = creationText(body.dependsOn, 'dependsOn', { maxLength: 4_000 });
      const requestedDependencies = parseDependsOn(dependsOn);
      if (!Object.hasOwn(body, 'dependsOn') || !reason || reason.length > 8_000) {
        sendJson(response, 400, { error: 'agent, reason and a complete dependsOn field are required within their size limits (dependsOn may be an empty string to clear all dependencies).' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        assertExecutableTask(record, 'receive a dependency revision');
        assertKnownDependencies(records, requestedDependencies, taskId);
        const storyDependencies = requestedDependencies
          .filter((dependencyId) => isStory(records.find(({ TaskID }) => TaskID === dependencyId)));
        if (storyDependencies.length) {
          const error = new Error(`Story is organizational only and cannot be used as DependsOn: ${storyDependencies.join(', ')}.`); error.statusCode = 422; throw error;
        }
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
      const taskId = safePathSegment(decodeSegment(blockMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'be blocked');
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
      const taskId = safePathSegment(decodeSegment(unblockMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'be dependency-unblocked');
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
        if (requiresIndependentReviewer(record)) assertSerialLaneAvailable(records, taskId);
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
      const taskId = safePathSegment(decodeSegment(parkMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'be parked');
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
      const taskId = safePathSegment(decodeSegment(admitMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'be admitted');
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
          if (requiresIndependentReviewer(record)) assertSerialLaneAvailable(records, taskId);
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
      const taskId = safePathSegment(decodeSegment(ownerWaitMatch[1]), 'Task ID');
      const authorityTaskId = safePathSegment(body.authorityTaskId, 'Authority task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'enter an owner wait');
        assertExecutableTask(authority, 'act as an owner-wait authority');
        if (requiresIndependentReviewer(record) || record.Status !== 'Backlog' || record.ReviewClaim || record.Implementer) {
          const error = new Error(`Only an unclaimed DecisionOwner Backlog task can enter an owner wait. ${taskId} is not eligible.`); error.statusCode = 409; throw error;
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
      const taskId = safePathSegment(decodeSegment(ownerEvaluationMatch[1]), 'Task ID');
      const agent = identityField(body.agent, 'agent');
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
        assertExecutableTask(record, 'receive an owner evaluation');
        if (record.Status !== 'Awaiting Agent Evaluation' || completionAuthority(record) !== 'DecisionOwner') {
          const error = new Error(`Only a DecisionOwner task in Awaiting Agent Evaluation can be resolved. ${taskId} is '${record.Status}'.`); error.statusCode = 409; throw error;
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
    const ownerFeedbackDispositionMatch = /^\/api\/tasks\/([^/]+)\/owner-feedback-disposition$/.exec(requestPath);
    if (request.method === 'POST' && ownerFeedbackDispositionMatch) {
      verifyMutationRequest(request);
      const body = await readJson(request);
      const taskId = safePathSegment(decodeSegment(ownerFeedbackDispositionMatch[1]), 'Task ID');
      const actor = identityField(body.actor, 'actor');
      const action = String(body.action ?? '').trim();
      const reason = String(body.reason ?? '').trim();
      const blocker = String(body.blocker ?? '').trim();
      const ownerStatus = String(body.ownerStatus ?? '').trim();
      if (!['resume', 'blocked', 'return-to-owner'].includes(action) || !reason || reason.length > 8_000
        || (action === 'blocked' && (!blocker || blocker.length > 4_000))
        || (action === 'return-to-owner' && !['Awaiting Owner', 'Awaiting Owner Gate'].includes(ownerStatus))) {
        sendJson(response, 400, { error: 'action must be resume, blocked or return-to-owner with a concrete reason; blocked requires blocker and return-to-owner requires ownerStatus.' });
        return;
      }
      const result = await withTrackerLock(async () => {
        const { header, records, trackerRevision } = await readTracker();
        requireRevision(body, trackerRevision);
        const record = records.find(({ TaskID }) => TaskID === taskId);
        if (!record) { const error = new Error(`Task '${taskId}' was not found.`); error.statusCode = 404; throw error; }
        assertExecutableTask(record, 'receive an owner-feedback disposition');
        if (record.Status !== 'Awaiting Agent Evaluation' || !requiresIndependentReviewer(record) || record.ReviewClaim) {
          const error = new Error(`Only an unclaimed IndependentReviewerAgent task awaiting Agent action can receive this disposition. ${taskId} is not eligible.`); error.statusCode = 409; throw error;
        }
        const activeRun = (await listTaskRuns(taskId)).find((run) => run.status === 'In Progress');
        if (activeRun) {
          const error = new Error(`Task '${taskId}' has active Run '${activeRun.runId}' and cannot receive an owner-feedback disposition.`); error.statusCode = 409; throw error;
        }
        const timestamp = new Date().toISOString();
        if (action === 'resume') {
          const unfinished = taskDependencies(record).filter((dependencyId) => records.find(({ TaskID }) => TaskID === dependencyId)?.Status !== 'Done');
          if (unfinished.length) {
            const error = new Error(`Cannot resume ${taskId}; unfinished dependencies: ${unfinished.join(', ')}.`); error.statusCode = 409; throw error;
          }
          assertSerialLaneAvailable(records, taskId);
          // The prior Run was closed before owner feedback. Its Implementer is
          // historical attribution, not a claim on the new implementation pass.
          record.Status = 'Ready'; record.Blocker = ''; record.Implementer = '';
        } else if (action === 'blocked') {
          record.Status = 'Blocked'; record.Blocker = blocker;
        } else {
          record.Status = ownerStatus;
          record.Blocker = 'Further owner action is required before this task can continue.';
        }
        record.Updated = timestamp;
        appendEvidence(record, `OWNER FEEDBACK DISPOSITION ${action}: ${actor} ${timestamp}; ${reason}`);
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
        assertExecutableTask(record, 'receive owner feedback');
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
    if (requestPath.startsWith('/api/') && ['GET', 'POST'].includes(request.method)) {
      throw httpError(404, `Unknown endpoint, or wrong HTTP method: ${request.method} ${requestPath.slice(0, 120)}. The endpoint list is in references/api.md of the game-task-hub skill.`, 'unknown-endpoint');
    }
    if (request.method === 'GET') {
      await serveStatic(requestPath, response);
      return;
    }
    response.writeHead(405, { Allow: 'GET, POST', 'X-Content-Type-Options': 'nosniff' }).end();
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) console.error(`task-hub: ${request.method} ${String(request.url).slice(0, 200)} failed:`, error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendJson(response, statusCode, {
      error: publicErrorMessage(error),
      ...(error?.hubCode ? { code: error.hubCode } : {}),
      ...(error?.dependencyAudit ? { dependencyAudit: error.dependencyAudit } : {}),
    });
  }
});

// ---- Start-up: single instance, endpoint files, fixed port ---------------------------
// tracker/.tracker-url and tracker/.tracker-pid are written here, after a
// successful listen, so every launch path (start.mjs, a bare `node server.mjs`,
// a service wrapper) publishes the same discovery information that tt reads.
const trackerDirectory = trackerPath ? dirname(trackerPath) : undefined;
const urlFilePath = trackerDirectory ? join(trackerDirectory, '.tracker-url') : undefined;
const pidFilePath = trackerDirectory ? join(trackerDirectory, '.tracker-pid') : undefined;

function canonicalBase(portNumber) {
  const publicHost = ['0.0.0.0', '::', '::0', 'localhost'].includes(host) ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${publicHost}:${portNumber}`;
}

async function probeHub(base) {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_500) });
    const body = await response.json();
    return body?.tool === 'task-hub' ? body : undefined;
  } catch {
    return undefined;
  }
}

// Another live server for this very CSV (any port) makes a second one pointless.
async function runningPeer() {
  if (!urlFilePath) return undefined;
  let recorded;
  try { recorded = readFileSync(urlFilePath, 'utf8').trim(); } catch { return undefined; }
  if (!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(recorded)) return undefined;
  const peer = await probeHub(recorded);
  return peer && peer.instanceId === instanceId && peer.pid !== process.pid ? { url: recorded, peer } : undefined;
}

function publishEndpoint() {
  if (!urlFilePath) return;
  try {
    writeFileSync(pidFilePath, `${process.pid}\n`);
    writeFileSync(urlFilePath, `${canonicalBase(activePort)}\n`); // last: its presence implies the pid file is current
  } catch (error) {
    console.error(`task-hub: could not write ${basename(urlFilePath)} (${error.code ?? error.message}); tt will fall back to the configured port.`);
  }
}

function withdrawEndpoint() {
  if (!pidFilePath) return;
  try {
    if (readFileSync(pidFilePath, 'utf8').trim() !== String(process.pid)) return; // not ours (a newer server took over)
    unlinkSync(pidFilePath);
    unlinkSync(urlFilePath);
  } catch { /* already gone */ }
}

process.on('exit', withdrawEndpoint);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => process.exit(0));
// Test-only: Windows has no catchable SIGTERM, so tests ask the server to take its
// normal clean-exit path (process.exit) to verify the endpoint files are removed.
if (process.env.NODE_ENV === 'test' && Number(process.env.TASK_HUB_TEST_EXIT_AFTER_MS) > 0) {
  setTimeout(() => process.exit(0), Number(process.env.TASK_HUB_TEST_EXIT_AFTER_MS));
}

let candidatePort = port;
let portAttempts = 0;

server.on('listening', () => {
  const address = server.address();
  activePort = typeof address === 'object' && address ? address.port : candidatePort;
  publishEndpoint();
  console.log(`Task tracker is available at http://${host}:${activePort}`);
  console.log(`CSV source of truth: ${trackerPath}`);
});

server.on('error', async (error) => {
  if (error?.code !== 'EADDRINUSE') {
    console.error(`task-hub: cannot listen on ${host}:${candidatePort} (${error?.code ?? error?.message}).`);
    process.exit(1);
  }
  const peer = await probeHub(`http://127.0.0.1:${candidatePort}`);
  if (peer?.instanceId === instanceId) {
    console.log(`Task tracker is already running at http://127.0.0.1:${candidatePort}`);
    process.exit(0);
  }
  if (portSetting.source === 'derived' && portAttempts < 25) {
    // A derived port is a preference, not a promise: another project (or program) holds it.
    portAttempts += 1;
    candidatePort = nextPortInRange(candidatePort);
    server.listen(candidatePort, host);
    return;
  }
  const holder = peer ? `by the tracker for project '${peer.projectId}'` : 'by another program';
  console.error(`task-hub: port ${candidatePort} is already in use ${holder}. Choose a free port with "instance.port" in task-hub.config.json or the PORT environment variable.`);
  process.exit(1);
});

const peer = await runningPeer();
if (peer) {
  console.log(`Task tracker is already running at ${peer.url}`);
  process.exit(0);
}
server.listen(candidatePort, host);
