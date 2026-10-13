#!/usr/bin/env node

import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || !value) throw new Error('Expected --name value argument pairs.');
  args[key.slice(2)] = value;
}
const projectId = args['project-id'];
const projectName = args['project-name'];
if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId ?? '')) throw new Error('--project-id must use lowercase letters, digits and hyphens.');
if (!projectName?.trim()) throw new Error('--project-name is required.');

const root = resolve(args.root ?? process.cwd());
const trackerDir = join(root, 'tracker');
const trackerPath = join(trackerDir, 'task_tracker.csv');
const configPath = join(root, 'task-hub.config.json');
const templatePath = join(dirname(dirname(fileURLToPath(import.meta.url))), 'templates', 'task_tracker.skeleton.csv');
let trackerExists = true;
try { await access(trackerPath, constants.F_OK); } catch (error) { if (error.code === 'ENOENT') trackerExists = false; else throw error; }
if (trackerExists) throw new Error(`${trackerPath} already exists; refusing to overwrite an instance.`);

await mkdir(trackerDir, { recursive: true });
await writeFile(configPath, `${JSON.stringify({ version: 1, instance: { projectId, projectName: projectName.trim(), tracker: 'tracker/task_tracker.csv', mode: 'managed-csv' }, workflow: { serialLane: true, ownerGateTaskPattern: '^GATE-' } }, null, 2)}\n`);
await copyFile(templatePath, trackerPath);
await writeFile(join(trackerDir, 'task_events.jsonl'), '');
await mkdir(join(trackerDir, 'task-records'), { recursive: true });
console.log(`Initialized ${projectName.trim()} tracker instance at ${root}`);
