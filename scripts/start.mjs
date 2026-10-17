#!/usr/bin/env node
// Start this instance's Hub.
//
//   node scripts/start.mjs            foreground: first stdout line is the URL, then the server log
//   node scripts/start.mjs --detach   background: wait until it answers, print the URL, exit 0
//
// The port is fixed per project (PORT env, else instance.port in
// task-hub.config.json, else derived from the project id in 4300-4999), so the
// URL is the same on every start. The server itself writes tracker/.tracker-url
// and tracker/.tracker-pid after it listens and removes them on a clean exit.
// Starting a second time prints the running server's URL instead of failing.
//
// Environment: HOST (default 127.0.0.1), PORT, TRACKER_CSV (tests / migrations).

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const detach = process.argv.includes('--detach');
const unknown = process.argv.slice(2).filter((argument) => argument !== '--detach');
if (unknown.length) {
  console.error(`start: unknown argument '${unknown[0]}' - supported: --detach - try: node scripts/start.mjs [--detach]`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(root, 'task-hub.config.json'), 'utf8').replace(/^﻿/, ''));
const trackerPath = process.env.TRACKER_CSV ? resolve(process.env.TRACKER_CSV) : resolve(root, config.instance?.tracker ?? 'tracker/task_tracker.csv');
const trackerDirectory = dirname(trackerPath);
const urlFile = join(trackerDirectory, '.tracker-url');
const pidFile = join(trackerDirectory, '.tracker-pid');
const logFile = join(trackerDirectory, 'server.log');
const env = { ...process.env, HOST: process.env.HOST ?? '127.0.0.1' };
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

function readText(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function tailOfLog() {
  return readText(logFile).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ').slice(0, 600);
}

if (detach) {
  mkdirSync(trackerDirectory, { recursive: true });
  // Keep the log bounded: restart it when it has grown past 512 KB.
  let size = 0;
  try { size = statSync(logFile).size; } catch { /* first start */ }
  const logDescriptor = openSync(logFile, size > 524_288 ? 'w' : 'a');
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', logDescriptor, logDescriptor],
  });
  closeSync(logDescriptor);
  let exitCode;
  child.once('exit', (code) => { exitCode = code ?? 1; });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (readText(pidFile) === String(child.pid) && /^http:\/\/\S+$/.test(readText(urlFile))) {
      console.log(readText(urlFile));
      process.exit(0);
    }
    if (exitCode !== undefined) {
      // The server exits 0 with "already running at <url>" when this instance is up.
      const running = /already running at (http:\/\/\S+)/.exec(tailOfLog());
      if (running && exitCode === 0) {
        console.log(running[1]);
        process.exit(0);
      }
      console.error(`start: the server exited with code ${exitCode} - ${tailOfLog() || 'no output'} - try: node scripts/start.mjs (foreground) to see the error, or tt doctor`);
      process.exit(1);
    }
  }
  console.error(`start: the server did not answer within 15 s - ${tailOfLog() || 'no output'} - try: node scripts/start.mjs (foreground) to see the error`);
  process.exit(1);
}

// Foreground: the first line on stdout is the URL, then the server's own output.
const child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });
let announced = false;
createInterface({ input: child.stdout }).on('line', (line) => {
  const match = /(?:available|already running) at (http:\/\/\S+)/.exec(line);
  if (!announced && match) {
    announced = true;
    const published = readText(urlFile);
    console.log(/^http:\/\/\S+$/.test(published) ? published : match[1]);
  }
  console.log(line);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
