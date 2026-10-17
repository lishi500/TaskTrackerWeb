#!/usr/bin/env node
// Initialize a Tracker instance (config + empty tracker folder) in the current
// directory, or in --root.
//
//   node scripts/init-instance.mjs --project-id my-game --project-name "My Game" [--empty] [--port 4321] [--root DIR]
//
//   --empty   tracker/task_tracker.csv gets only the header row. Without it the
//             illustrative skeleton rows are copied; replace them before real use.
//   --port N  fixed port for this instance (written to instance.port). Without
//             it a stable port in 4300-4999 is derived from the project id and
//             moved up to the next free one if it is busy right now.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePort, nextPortInRange, parsePortNumber } from './lib/hub-port.mjs';

function fail(what, why, next) {
  console.error(`init-instance: ${what} - ${why}${next ? ` - try: ${next}` : ''}`);
  process.exit(1);
}

const usage = 'node scripts/init-instance.mjs --project-id my-game --project-name "My Game" [--empty] [--port 4321] [--root DIR]';
const valueOptions = new Set(['project-id', 'project-name', 'root', 'port']);
const booleanOptions = new Set(['empty']);
const args = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const key = argv[index];
  const name = key.startsWith('--') ? key.slice(2) : '';
  if (booleanOptions.has(name)) {
    args[name] = true;
  } else if (valueOptions.has(name)) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${key} needs a value`, 'it was followed by nothing or by another option', usage);
    args[name] = value;
    index += 1;
  } else {
    fail(`unknown argument '${key}'`, 'supported: --project-id --project-name --empty --port --root', usage);
  }
}

const projectId = args['project-id'];
const projectName = args['project-name'];
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId ?? '')) fail('--project-id is invalid', 'use 2-63 lowercase letters, digits and hyphens, starting with a letter or digit', usage);
if (!projectName?.trim()) fail('--project-name is required', 'it names the dashboard', usage);
let explicitPort;
try {
  if (args.port !== undefined) explicitPort = parsePortNumber(args.port, '--port');
} catch (error) {
  fail('--port is invalid', error.message, usage);
}

const root = resolve(args.root ?? process.cwd());
const trackerDir = join(root, 'tracker');
const trackerPath = join(trackerDir, 'task_tracker.csv');
const configPath = join(root, 'task-hub.config.json');
const templatePath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'templates', 'task_tracker.skeleton.csv');
let trackerExists = true;
try { await access(trackerPath, constants.F_OK); } catch (error) { if (error.code === 'ENOENT') trackerExists = false; else throw error; }
if (trackerExists) fail('this instance is already initialized', `${trackerPath} exists and is never overwritten`, 'node scripts/start.mjs --detach (starts the existing instance)');

function portIsFree(candidate) {
  return new Promise((resolveFree) => {
    const probe = createServer();
    probe.once('error', () => resolveFree(false));
    probe.once('listening', () => probe.close(() => resolveFree(true)));
    probe.listen(candidate, '127.0.0.1');
  });
}

let port = explicitPort;
let portNote = 'from --port';
if (port === undefined) {
  port = derivePort(projectId);
  portNote = 'derived from the project id';
  for (let attempt = 0; attempt < 50 && !(await portIsFree(port)); attempt += 1) {
    port = nextPortInRange(port);
    portNote = 'derived from the project id, moved because the first choice is busy';
  }
}

await mkdir(trackerDir, { recursive: true });
await writeFile(configPath, `${JSON.stringify({
  version: 1,
  instance: { projectId, projectName: projectName.trim(), tracker: 'tracker/task_tracker.csv', mode: 'managed-csv', port },
  workflow: { serialLane: true, ownerGateTaskPattern: '^GATE-' },
}, null, 2)}\n`);
// The skeleton may be checked out with CRLF on Windows; the Hub writes LF.
const skeleton = (await readFile(templatePath, 'utf8')).replace(/^﻿/, '').replace(/\r\n/g, '\n');
await writeFile(trackerPath, args.empty ? `${skeleton.split('\n')[0]}\n` : skeleton);
await writeFile(join(trackerDir, 'task_events.jsonl'), '');
await mkdir(join(trackerDir, 'task-records'), { recursive: true });
// Runtime files that must never be committed to the instance repository.
try {
  await writeFile(join(trackerDir, '.gitignore'), '.tracker-url\n.tracker-pid\nserver.log\n*.lock\n*.tmp\n', { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
console.log(`Initialized ${projectName.trim()} tracker instance at ${root}`);
console.log(`tracker: ${args.empty ? 'empty (header only)' : 'skeleton sample rows (replace before real use)'}`);
console.log(`port: ${port} (${portNote})  url: http://127.0.0.1:${port}`);
console.log('next: node scripts/start.mjs --detach');
