#!/usr/bin/env node

import { createServer } from 'node:http';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
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
  return { header, records };
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

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16_384) {
      const error = new Error('Feedback is limited to 16 KB.');
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
      const { records } = await readTracker();
      sendJson(response, 200, { records });
      return;
    }
    if (request.method === 'GET' && requestPath === '/api/summary') {
      const { records } = await readTracker();
      sendJson(response, 200, summarize(records));
      return;
    }
    if (request.method === 'POST' && requestPath === '/api/feedback') {
      verifyFeedbackRequest(request);
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
        const { header, records } = await readTracker();
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
        return { record, timestamp };
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
