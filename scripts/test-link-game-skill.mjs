#!/usr/bin/env node
// link-game-skill: junction on Windows (no admin), .claude/skills by default,
// idempotent, refuses foreign targets and real directories, git exclude,
// no leftover empty directories on failure.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const script = join(repo, 'scripts', 'link-game-skill.mjs');
const skillSource = join(repo, '.agents', 'skills', 'game-task-hub');
const sandbox = mkdtempSync(join(tmpdir(), 'task-tracker-link-'));
const createdLinks = [];

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

// Remove a link without ever touching its target (rmdir on a junction removes only the point).
function removeLink(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return;
    if (process.platform === 'win32') rmdirSync(path); else unlinkSync(path);
  } catch { /* already gone */ }
}

const isLinkTo = (path, target) => lstatSync(path).isSymbolicLink()
  && realpathSync.native(path).toLowerCase() === realpathSync.native(target).toLowerCase();

function newGame(name, { git = true } = {}) {
  const dir = join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  if (git) mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  return dir;
}

try {
  // 1. fresh link in a path with a space and Chinese characters, git repository.
  const game = newGame('My Game 游戏');
  const claudeLink = join(game, '.claude', 'skills', 'game-task-hub');
  let result = run([game]);
  assert.equal(result.status, 0, result.err);
  createdLinks.push(claudeLink);
  assert.ok(isLinkTo(claudeLink, skillSource), 'junction/symlink must point at the instance skill');
  assert.ok(existsSync(join(claudeLink, 'SKILL.md')), 'SKILL.md must be readable through the link');
  assert.match(result.out, /^linked:/m);
  const exclude = join(game, '.git', 'info', 'exclude');
  assert.equal(readFileSync(exclude, 'utf8').split('\n').filter((line) => line === '/.claude/skills/game-task-hub').length, 1);

  // 2. idempotent: second run changes nothing and does not duplicate the exclude line.
  result = run([game]);
  assert.equal(result.status, 0, result.err);
  assert.match(result.out, /already linked/);
  assert.equal(readFileSync(exclude, 'utf8').split('\n').filter((line) => line === '/.claude/skills/game-task-hub').length, 1);

  // 3. --agents adds the Codex link as well.
  result = run([game, '--agents']);
  assert.equal(result.status, 0, result.err);
  const agentsLink = join(game, '.agents', 'skills', 'game-task-hub');
  createdLinks.push(agentsLink);
  assert.ok(isLinkTo(agentsLink, skillSource));
  assert.match(readFileSync(exclude, 'utf8'), /^\/\.agents\/skills\/game-task-hub$/m);

  // 4. a link that targets somewhere else is refused; --force repoints only the link.
  const foreignTarget = join(sandbox, 'foreign-skill');
  mkdirSync(foreignTarget);
  writeFileSync(join(foreignTarget, 'marker.txt'), 'keep me');
  const game2 = newGame('foreign');
  mkdirSync(join(game2, '.claude', 'skills'), { recursive: true });
  const foreignLink = join(game2, '.claude', 'skills', 'game-task-hub');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(foreignTarget, foreignLink, process.platform === 'win32' ? 'junction' : 'dir');
  createdLinks.push(foreignLink);
  result = run([game2]);
  assert.equal(result.status, 1);
  assert.match(result.err, /link to somewhere else/);
  assert.ok(isLinkTo(foreignLink, foreignTarget), 'refused run must leave the foreign link untouched');
  result = run([game2, '--force']);
  assert.equal(result.status, 0, result.err);
  assert.ok(isLinkTo(foreignLink, skillSource), '--force repoints the link');
  assert.equal(readFileSync(join(foreignTarget, 'marker.txt'), 'utf8'), 'keep me', 'the old link target must survive');

  // 5. a real directory is never replaced, with or without --force.
  const game3 = newGame('realdir');
  mkdirSync(join(game3, '.claude', 'skills', 'game-task-hub'), { recursive: true });
  writeFileSync(join(game3, '.claude', 'skills', 'game-task-hub', 'keep.txt'), 'precious');
  for (const args of [[game3], [game3, '--force']]) {
    result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.err, /real file or directory/);
  }
  assert.equal(readFileSync(join(game3, '.claude', 'skills', 'game-task-hub', 'keep.txt'), 'utf8'), 'precious');

  // 6. option handling.
  const game4 = newGame('options', { git: false });
  result = run([game4, '--no-claude']);
  assert.equal(result.status, 1);
  assert.match(result.err, /nothing to link/);
  result = run([game4, '--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.err, /unknown option --bogus/);
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.err, /game directory is required/);
  result = run([game4, '--agents', '--no-claude']);
  assert.equal(result.status, 0, result.err);
  createdLinks.push(join(game4, '.agents', 'skills', 'game-task-hub'));
  assert.ok(!existsSync(join(game4, '.claude')), '--no-claude must not create .claude');
  assert.match(result.out, /not a git repository/);

  // 7. a missing game directory is an error and is not created.
  const missing = join(sandbox, 'does-not-exist');
  result = run([missing]);
  assert.equal(result.status, 1);
  assert.match(result.err, /game directory not found/);
  assert.ok(!existsSync(missing));

  // 8. failure while creating the link leaves no empty directories behind.
  const game5 = newGame('failing', { git: false });
  result = run([game5], { TASK_HUB_TEST_LINK_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.err, /cannot create the link/);
  assert.deepEqual(readdirSync(game5), [], 'no .claude/skills directories may remain after a failed link');

  // 9. a git worktree-style ".git" file resolves to the common dir's info/exclude.
  const game6 = newGame('worktree', { git: false });
  const commonGit = join(sandbox, 'common.git');
  mkdirSync(join(commonGit, 'worktrees', 'wt1'), { recursive: true });
  writeFileSync(join(commonGit, 'worktrees', 'wt1', 'commondir'), '../..\n');
  writeFileSync(join(game6, '.git'), `gitdir: ${join(commonGit, 'worktrees', 'wt1')}\n`);
  result = run([game6]);
  assert.equal(result.status, 0, result.err);
  createdLinks.push(join(game6, '.claude', 'skills', 'game-task-hub'));
  assert.match(readFileSync(join(commonGit, 'info', 'exclude'), 'utf8'), /^\/\.claude\/skills\/game-task-hub$/m);

  console.log(`link-game-skill test passed on ${process.platform}: ${process.platform === 'win32' ? 'junction without admin' : 'symlink'}, idempotent, foreign/real targets refused, git exclude, clean failure.`);
} finally {
  for (const link of createdLinks) removeLink(link);
  rmSync(sandbox, { recursive: true, force: true });
}
