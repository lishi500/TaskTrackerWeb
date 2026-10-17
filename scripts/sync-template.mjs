#!/usr/bin/env node

import { cp, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedPaths = [
  '.gitattributes',
  'Dockerfile',
  'README.md',
  'server.mjs',
  'task-hub.config.example.json',
  'task_hub_product_spec.md',
  'public',
  'scripts/init-instance.mjs',
  'scripts/link-game-skill.mjs',
  'scripts/start.mjs',
  'scripts/tt.mjs',
  'scripts/lib',
  'scripts/test-all.mjs',
  'scripts/test-managed-runs.mjs',
  'scripts/test-serial-lane.mjs',
  'scripts/test-dependency-audit.mjs',
  'scripts/test-task-types-and-toolchain-issues.mjs',
  'scripts/test-delivery-context.mjs',
  'scripts/test-static-assets.mjs',
  'scripts/test-windows-robustness.mjs',
  'scripts/test-http-hardening.mjs',
  'scripts/test-agent-api.mjs',
  'scripts/test-start-init.mjs',
  'scripts/test-link-game-skill.mjs',
  'scripts/test-platform.mjs',
  'scripts/test-run-evidence.mjs',
  'scripts/test-tt-story.mjs',
  'scripts/test-taskset.mjs',
  'scripts/test-tt.mjs',
  'scripts/test-skill.mjs',
  'scripts/sync-template.mjs',
  'scripts/test-template-sync.mjs',
  'templates',
  '.agents/skills/game-task-hub',
];

const args = new Set(process.argv.slice(2));
const targetFlagIndex = process.argv.indexOf('--target');
const targetValue = targetFlagIndex >= 0 ? process.argv[targetFlagIndex + 1] : '';
const apply = args.has('--apply');
if (!targetValue || targetValue.startsWith('--')) throw new Error('Usage: node scripts/sync-template.mjs --target /absolute/path/to/Tracker-instance [--apply]');
const targetRoot = resolve(targetValue);
if (targetRoot === templateRoot) throw new Error('The target must be a distinct Tracker instance, not this template repository.');

async function fileInfo(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function directoryEntries(root, prefix = '') {
  const info = await fileInfo(root);
  if (!info) return [];
  if (info.isSymbolicLink()) return [{ path: prefix, kind: 'symlink' }];
  if (info.isFile()) return [{ path: prefix, kind: 'file', content: await readFile(root) }];
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(root)).sort();
  const entries = [];
  for (const name of names) entries.push(...await directoryEntries(resolve(root, name), prefix ? `${prefix}/${name}` : name));
  return entries;
}

async function comparePath(source, target) {
  const targetInfo = await fileInfo(target);
  if (!targetInfo) return 'missing';
  if (targetInfo.isSymbolicLink()) return 'unsafe-symlink';
  const sourceEntries = await directoryEntries(source);
  const targetEntries = await directoryEntries(target);
  if (sourceEntries.length !== targetEntries.length) return 'different';
  for (let index = 0; index < sourceEntries.length; index += 1) {
    const left = sourceEntries[index];
    const right = targetEntries[index];
    if (left.path !== right.path || left.kind !== right.kind || left.kind === 'symlink') return 'different';
    if (left.kind === 'file' && !left.content.equals(right.content)) return 'different';
  }
  return 'current';
}

const targetInfo = await fileInfo(targetRoot);
if (!targetInfo?.isDirectory()) throw new Error(`Target '${targetRoot}' must be an existing directory.`);
const results = [];
for (const templatePath of sharedPaths) {
  const source = resolve(templateRoot, templatePath);
  const target = resolve(targetRoot, templatePath);
  if (relative(templateRoot, source).startsWith('..') || relative(targetRoot, target).startsWith('..')) throw new Error(`Invalid shared path '${templatePath}'.`);
  const status = await comparePath(source, target);
  results.push({ path: templatePath, status });
}

const unsafe = results.filter(({ status }) => status === 'unsafe-symlink');
if (unsafe.length) throw new Error(`Refusing to follow or overwrite target symlink(s): ${unsafe.map(({ path }) => path).join(', ')}.`);
if (apply) {
  for (const { path: templatePath, status } of results) {
    if (status === 'current') continue;
    const source = resolve(templateRoot, templatePath);
    const target = resolve(targetRoot, templatePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, preserveTimestamps: true });
  }
}

console.log(JSON.stringify({
  mode: apply ? 'applied' : 'check',
  templateRoot,
  targetRoot,
  protectedInstancePaths: ['tracker/', 'task-hub.config.json'],
  sharedPaths: results,
}, null, 2));
