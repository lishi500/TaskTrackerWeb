#!/usr/bin/env node
// Link this Tracker instance's game-task-hub skill into a game repository.
//
//   node scripts/link-game-skill.mjs <gameDir> [--agents] [--no-claude] [--force]
//
// Default link: <gameDir>/.claude/skills/game-task-hub   (what Claude Code reads)
// --agents:     also <gameDir>/.agents/skills/game-task-hub (Codex)
// --no-claude:  skip the .claude link (use with --agents)
// --force:      repoint a link that targets somewhere else. A real directory or
//               file is never replaced.
//
// Windows uses a directory junction, which needs no admin rights or developer
// mode (a 'dir' symlink fails with EPERM there). POSIX uses a symlink.
// Re-running is a no-op when the link already points at this skill.

import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillName = 'game-task-hub';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '.agents', 'skills', skillName);
const isWindows = process.platform === 'win32';

function fail(what, why, next) {
  console.error(`link-game-skill: ${what} - ${why}${next ? ` - try: ${next}` : ''}`);
  process.exit(1);
}

const usage = 'node scripts/link-game-skill.mjs <gameDir> [--agents] [--no-claude] [--force]';
const flags = new Set();
const positional = [];
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--')) flags.add(argument);
  else positional.push(argument);
}
const knownFlags = new Set(['--agents', '--no-claude', '--force', '--help']);
const unknownFlag = [...flags].find((flag) => !knownFlags.has(flag));
if (flags.has('--help')) { console.log(`Usage: ${usage}`); process.exit(0); }
if (unknownFlag) fail(`unknown option ${unknownFlag}`, 'supported: --agents --no-claude --force', usage);
if (positional.length !== 1) fail('game directory is required', 'exactly one <gameDir> argument is expected', usage);
if (flags.has('--no-claude') && !flags.has('--agents')) fail('nothing to link', '--no-claude without --agents leaves no destination', usage);

const gameRoot = resolve(positional[0]);
if (!existsSync(gameRoot) || !statSync(gameRoot).isDirectory()) fail('game directory not found', `'${gameRoot}' is not an existing directory`, 'create the game project first (new-game), then re-run');
if (!existsSync(join(source, 'SKILL.md'))) fail('skill source not found', `'${source}' has no SKILL.md`, 're-sync this tracker instance from the template');

const destinations = [];
if (!flags.has('--no-claude')) destinations.push(['.claude', 'skills', skillName]);
if (flags.has('--agents')) destinations.push(['.agents', 'skills', skillName]);

const sameFile = (left, right) => (isWindows ? left.toLowerCase() === right.toLowerCase() : left === right);

function realpathOrUndefined(path) {
  try { return realpathSync.native(path); } catch { return undefined; }
}

function describeLink(path) {
  try { return readlinkSync(path); } catch { return '(unreadable)'; }
}

// Remove only the link itself, never anything it points to. rmdir/unlink fail
// on a non-empty real directory, so a misdetected directory cannot be wiped.
function removeLink(path) {
  if (isWindows) rmdirSync(path);
  else unlinkSync(path);
}

function removeEmptyDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    try { rmdirSync(directory); } catch { /* not empty or already gone: leave it */ }
  }
}

function ensureParents(destination) {
  const created = [];
  const missing = [];
  for (let directory = dirname(destination); !existsSync(directory); directory = dirname(directory)) missing.unshift(directory);
  try {
    for (const directory of missing) {
      mkdirSync(directory);
      created.push(directory);
    }
  } catch (error) {
    removeEmptyDirectories(created);
    throw error;
  }
  return created;
}

function linkOne(parts) {
  const destination = join(gameRoot, ...parts);
  let existing;
  try { existing = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      fail(`cannot link ${destination}`, 'a real file or directory already exists there; it is never replaced', 'move or delete it yourself, then re-run');
    }
    const target = realpathOrUndefined(destination);
    const expected = realpathOrUndefined(source);
    if (target && expected && sameFile(target, expected)) return { destination, action: 'already linked' };
    if (!flags.has('--force')) {
      fail(`cannot link ${destination}`, `it is a link to somewhere else (${describeLink(destination)})`, `add --force to repoint it: ${usage}`);
    }
    removeLink(destination);
  }
  let created = [];
  try {
    created = ensureParents(destination);
    if (process.env.NODE_ENV === 'test' && process.env.TASK_HUB_TEST_LINK_FAIL === '1') {
      throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
    }
    symlinkSync(source, destination, isWindows ? 'junction' : 'dir');
  } catch (error) {
    removeEmptyDirectories(created);
    fail(`cannot create the link at ${destination}`, `${error.code ?? 'error'}: ${error.message}`, isWindows ? 'check that the game path is on a local NTFS drive (junctions cannot cross to network shares)' : 'check permissions on the game directory');
  }
  return { destination, action: existing ? 'repointed' : 'linked' };
}

// Locate <gameDir>'s git exclude file (handles worktrees where .git is a file).
function gitExcludePath() {
  const dotGit = join(gameRoot, '.git');
  if (!existsSync(dotGit)) return undefined;
  let gitDirectory = dotGit;
  if (statSync(dotGit).isFile()) {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!pointer) return undefined;
    gitDirectory = resolve(gameRoot, pointer[1].trim());
    const commonFile = join(gitDirectory, 'commondir');
    if (existsSync(commonFile)) gitDirectory = resolve(gitDirectory, readFileSync(commonFile, 'utf8').trim());
  }
  return join(gitDirectory, 'info', 'exclude');
}

function excludeFromGit(entries) {
  const excludePath = gitExcludePath();
  if (!excludePath) return 'not a git repository (no exclude entry written)';
  const patterns = entries.map((entry) => `/${entry.join('/')}`);
  let current = '';
  try { current = readFileSync(excludePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !present.has(pattern));
  if (!missing.length) return 'already listed in .git/info/exclude';
  mkdirSync(dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, `${current === '' || current.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  return `added ${missing.join(', ')} to .git/info/exclude`;
}

const results = destinations.map(linkOne);
for (const { destination, action } of results) console.log(`${action}: ${destination} -> ${source}`);
console.log(`git: ${excludeFromGit(destinations)}`);
