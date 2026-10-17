#!/usr/bin/env node
// tt finds the tracker instance WITHOUT any junction or symlink: the skill is a plain COPY inside a game.
// Order (CONTRACTS-2 section 3): TT_DIR, tracker.json beside the skill's scripts/, .tt-dir in the project
// root, sibling <project>-Tracker, then the real location of tt.mjs. `tt doctor` prints which one won.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInstance, runSuite, skipNote } from './lib/test-support.mjs';

const BOM = String.fromCharCode(0xFEFF);
const parent = mkdtempSync(join(tmpdir(), 'Hub discovery 发现 '));
const instances = [];
const cleanEnv = { ...process.env };
for (const name of ['TT_URL', 'TT_DIR', 'TT_AGENT', 'TT_REVIEWER']) delete cleanEnv[name];

const run = (script, args, { cwd, env = {} } = {}) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv, ...env } });
  return { status: result.status, out: result.stdout, err: result.stderr, lines: result.stdout.split('\n').filter(Boolean) };
};
const ok = (result) => { assert.equal(result.status, 0, `exit ${result.status}: ${result.err}${result.out}`); return result; };

// Does any folder above `start` look like a project root? (then "nothing found" cannot be tested here)
function hasProjectRootAbove(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'AGENTS.md')) || existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

await runSuite('discovery', async () => {
  // two instances next to a game folder named so that "<game>-Tracker" is instance A
  const a = await createInstance({ parent, name: 'Fish Game-Tracker', exactName: true, projectId: 'disco-a', projectName: 'Disco A' });
  const b = await createInstance({ parent, name: 'Other-Tracker', exactName: true, projectId: 'disco-b', projectName: 'Disco B' });
  instances.push(a, b);
  const game = join(parent, 'Fish Game');
  const deep = join(game, 'src', 'deep', 'inside');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(game, 'AGENTS.md'), '# Fish Game\n');

  // the skill as gd-skill installs it: a COPY, no link anywhere
  const skill = join(game, '.claude', 'skills', 'game-task-hub');
  mkdirSync(dirname(skill), { recursive: true });
  cpSync(join(a.root, '.agents', 'skills', 'game-task-hub'), skill, { recursive: true });
  const tt = join(skill, 'scripts', 'tt.mjs');
  for (const path of [skill, join(skill, 'scripts'), tt]) assert.equal(lstatSync(path).isSymbolicLink(), false, `${path} is a plain copy`);
  assert.ok(!tt.startsWith(a.root) && !tt.startsWith(b.root), 'the copy is outside every instance');

  // both servers up (explicit TT_DIR), then `tt url` tells which instance a given setup finds
  assert.equal(ok(run(tt, ['up'], { cwd: parent, env: { TT_DIR: a.root } })).out.trim(), a.url);
  assert.equal(ok(run(tt, ['up'], { cwd: parent, env: { TT_DIR: b.root } })).out.trim(), b.url);
  const urlOf = (cwd, env) => ok(run(tt, ['url'], { cwd, env })).out.trim();
  const doctor = (cwd, env) => ok(run(tt, ['doctor'], { cwd, env })).out;

  // ---- 4. sibling <project>-Tracker, from any depth ---------------------------------------------------------------
  assert.equal(urlOf(game), a.url, 'from the project root');
  assert.equal(urlOf(deep), a.url, 'from a nested folder');
  let report = doctor(deep);
  assert.match(report, /^ok {3}instance .*Fish Game-Tracker \(project disco-a, port \d+\)$/m);
  assert.match(report, /^ok {3}found by step 4 sibling -Tracker folder: .*Fish Game-Tracker next to .*Fish Game$/m);
  assert.match(report, /^info step 1 TT_DIR: TT_DIR is not set$/m, 'doctor says why the earlier steps did not apply');
  assert.match(report, /^info step 2 tracker\.json: no tracker\.json beside .*scripts$/m);
  assert.match(report, /^info step 3 \.tt-dir: no \.tt-dir in /m);

  // ---- 3. .tt-dir beats the sibling; BOM, CRLF and blank lines are tolerated ---------------------------------------------
  writeFileSync(join(game, '.tt-dir'), `${BOM}\r\n${b.root}\r\n\r\n`);
  assert.equal(urlOf(deep), b.url);
  report = doctor(deep);
  assert.match(report, /^ok {3}found by step 3 \.tt-dir: .*[\\/]\.tt-dir$/m);

  // ---- 2. tracker.json beside scripts/ beats .tt-dir ------------------------------------------------------------------------
  writeFileSync(join(skill, 'tracker.json'), `${BOM}${JSON.stringify({ dir: a.root })}\n`);
  assert.equal(urlOf(deep), a.url);
  assert.match(doctor(deep), /^ok {3}found by step 2 tracker\.json: .*tracker\.json$/m);

  // ---- 1. TT_DIR beats everything ---------------------------------------------------------------------------------------------
  assert.equal(urlOf(deep, { TT_DIR: b.root }), b.url);
  assert.match(doctor(deep, { TT_DIR: b.root }), /^ok {3}found by step 1 TT_DIR: TT_DIR=.*Other-Tracker$/m);

  // an explicit TT_DIR that is wrong is an error, never a silent fall-through
  const wrong = run(tt, ['url'], { cwd: deep, env: { TT_DIR: join(parent, 'nowhere') } });
  assert.equal(wrong.status, 1);
  assert.match(wrong.err, /^tt: cannot find the tracker instance - TT_DIR=.*nowhere which has no server\.mjs and task-hub\.config\.json - try: fix or unset TT_DIR/);
  const wrongDoctor = run(tt, ['doctor'], { cwd: deep, env: { TT_DIR: join(parent, 'nowhere') } });
  assert.equal(wrongDoctor.status, 1);
  assert.match(wrongDoctor.out, /^FAIL step 1 TT_DIR: TT_DIR=.*nowhere which has no server\.mjs/m);

  // ---- broken pointers fall through, and doctor explains --------------------------------------------------------------------------
  writeFileSync(join(skill, 'tracker.json'), JSON.stringify({ dir: join(parent, 'moved-away') }));
  assert.equal(urlOf(deep), b.url, 'a stale tracker.json falls through to .tt-dir');
  report = doctor(deep);
  assert.match(report, /^ok {3}found by step 3 \.tt-dir/m);
  assert.match(report, /^warn step 2 tracker\.json: .*tracker\.json points to .*moved-away, which has no server\.mjs and task-hub\.config\.json$/m);

  writeFileSync(join(skill, 'tracker.json'), '{ not json');
  assert.equal(urlOf(deep), b.url);
  assert.match(doctor(deep), /^warn step 2 tracker\.json: .*tracker\.json is not valid JSON/m);
  writeFileSync(join(skill, 'tracker.json'), JSON.stringify({ dir: 'relative/folder' }));
  assert.equal(urlOf(deep), b.url);
  assert.match(doctor(deep), /^warn step 2 tracker\.json: .*tracker\.json holds the relative path 'relative\/folder'; write the absolute path of the tracker folder$/m);
  writeFileSync(join(skill, 'tracker.json'), JSON.stringify({ other: 1 }));
  assert.match(doctor(deep), /^warn step 2 tracker\.json: .*tracker\.json is empty$/m);

  // a relative .tt-dir is refused (a cloned repository must not steer tt at scripts it ships); the sibling still works
  writeFileSync(join(game, '.tt-dir'), '../Other-Tracker\n');
  writeFileSync(join(skill, 'tracker.json'), '{}');
  assert.equal(urlOf(deep), a.url, 'sibling after a refused relative .tt-dir');
  assert.match(doctor(deep), /^warn step 3 \.tt-dir: .*\.tt-dir holds the relative path '\.\.\/Other-Tracker'; write the absolute path/m);
  writeFileSync(join(game, '.tt-dir'), `${join(parent, 'missing-tracker')}\n`);
  assert.match(doctor(deep), /^warn step 3 \.tt-dir: .*\.tt-dir points to .*missing-tracker, which has no server\.mjs/m);
  assert.equal(urlOf(deep), a.url);

  // ---- nested repositories: outer project folders count too ------------------------------------------------------------------------
  const nested = join(game, 'addons', 'nested', 'x');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(game, 'addons', 'nested', '.git'), 'gitdir: ../../.git/modules/nested\n'); // a submodule/worktree marker is a file
  writeFileSync(join(game, '.tt-dir'), `${b.root}\n`);
  assert.equal(urlOf(nested), b.url, 'the .tt-dir of the outer project folder is found from inside a nested repository');
  mkdirSync(join(game, '.git')); // sibling check from the outer project, with its pointer removed
  writeFileSync(join(game, '.tt-dir'), '\n');
  assert.equal(urlOf(nested), a.url, 'an empty .tt-dir is ignored; the sibling of the outer folder is used');

  // ---- 5. the old behaviour: tt.mjs inside an instance; and nothing found -----------------------------------------------------------------
  const bare = mkdtempSync(join(parent, 'bare '));
  rmSync(join(skill, 'tracker.json'));
  if (hasProjectRootAbove(bare)) {
    skipNote('step 5 and "nothing found" checks: a folder above the temp directory has AGENTS.md or .git, so steps 3 and 4 could answer first');
  } else {
    const own = join(b.root, '.agents', 'skills', 'game-task-hub', 'scripts', 'tt.mjs');
    assert.equal(ok(run(own, ['url'], { cwd: bare })).out.trim(), b.url);
    report = ok(run(own, ['doctor'], { cwd: bare })).out;
    assert.match(report, /^ok {3}found by step 5 location of tt\.mjs: .*tt\.mjs is inside it$/m);
    assert.equal(ok(run(join(b.root, 'scripts', 'tt.mjs'), ['url'], { cwd: bare })).out.trim(), b.url, 'the stub in the instance root');

    // nothing found: one message that lists the five places
    const lost = run(tt, ['url'], { cwd: bare });
    assert.equal(lost.status, 1);
    assert.match(lost.err, /^tt: cannot find the tracker instance - none of the 5 places names one - try: write the absolute path of the <Game>-Tracker folder into <game>\/\.tt-dir \(gd-skill activate --tracker DIR does\), or set TT_DIR/);
    for (const step of ['1. TT_DIR: TT_DIR is not set', '2. tracker.json: no tracker.json beside', '3. .tt-dir: no folder with AGENTS.md or .git at or above', '4. sibling -Tracker folder: no project folder to look next to', '5. location of tt.mjs: ']) {
      assert.ok(lost.err.includes(`  ${step}`), `the message lists step ${step}`);
    }
    const lostDoctor = run(tt, ['doctor'], { cwd: bare });
    assert.equal(lostDoctor.status, 1);
    assert.match(lostDoctor.out, /^FAIL no tracker instance found - write the absolute path of the <Game>-Tracker folder into <game>\/\.tt-dir/m);
  }

  // ---- a project root with only AGENTS.md or only .git works the same ---------------------------------------------------------------------
  const gitOnly = join(parent, 'Git Only');
  mkdirSync(join(gitOnly, '.git'), { recursive: true });
  const c = await createInstance({ parent, name: 'Git Only-Tracker', exactName: true, projectId: 'disco-c', projectName: 'Disco C' });
  instances.push(c);
  assert.equal(ok(run(tt, ['up'], { cwd: parent, env: { TT_DIR: c.root } })).out.trim(), c.url);
  assert.equal(urlOf(gitOnly), c.url, '.git alone marks a project root');

  console.log('discovery test passed: TT_DIR, tracker.json, .tt-dir, sibling -Tracker and the tt.mjs location, in that order, with a copied skill and no links; broken pointers explained by doctor.');
}, async () => {
  for (const instance of instances) await instance.dispose();
  try { rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* a busy temp folder is not a test failure */ }
});
