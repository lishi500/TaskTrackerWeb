#!/usr/bin/env node
// The CI failure channel: test-all.mjs ends a failing run with a digest, scripts/ci-annotate.mjs turns it into
// GitHub workflow commands (annotations are public, job logs are not), and the workflow wires the two together.
// Checked end to end with fake suites, so a broken channel is noticed before the day it is needed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnnotations, clipMessage, command, describeEnvironment, escapeData, escapeProperty, portScan } from './ci-annotate.mjs';
import { getFreePort, removeDirectory, runSuite } from './lib/test-support.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const unescape = (text) => text.replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%25/g, '%');
let scratch;

await runSuite('ci-annotate', async () => {
  // ---- escaping: % CR LF in data, plus : and , in a property ----------------------------------------------------
  assert.equal(escapeData('100%\r\nnext\nline'), '100%25%0D%0Anext%0Aline');
  assert.equal(escapeProperty('FAIL test-x.mjs: a, b'), 'FAIL test-x.mjs%3A a%2C b');
  assert.equal(command('error', 'title: x', 'one\ntwo'), '::error title=title%3A x::one%0Atwo');
  const long = `${'head '.repeat(300)}MIDDLE${'x'.repeat(8000)}tail-end`;
  const clipped = clipMessage(long);
  assert.ok(clipped.length <= 2900, `clipped to ${clipped.length}`);
  assert.ok(clipped.startsWith('head head') && clipped.endsWith('tail-end') && clipped.includes('\n...\n'), 'the start and the end survive');

  // ---- a real failing run of test-all with fake suites -----------------------------------------------------------
  scratch = mkdtempSync(join(tmpdir(), 'ci-annotate-'));
  const scripts = join(scratch, 'scripts');
  mkdirSync(scripts);
  copyFileSync(join(here, 'test-all.mjs'), join(scripts, 'test-all.mjs'));
  writeFileSync(join(scripts, 'test-good.mjs'), "console.log('all good');\n");
  writeFileSync(join(scripts, 'test-skipper.mjs'), "console.log('SKIP: no display on this machine');\n");
  // the first line tries to inject a workflow command; the assertion carries a message with % and a colon
  writeFileSync(join(scripts, 'test-bad.mjs'), "import assert from 'node:assert/strict';\nconsole.log('::set-output name=x::y');\nconsole.log('step 1 of 3 done (100% sure)');\nassert.equal(1, 2, 'one is not two: 50% of the time');\n");
  writeFileSync(join(scripts, 'test-hang.mjs'), "console.log('about to hang');\nsetInterval(() => {}, 1000);\n");
  const run = spawnSync(process.execPath, [join(scripts, 'test-all.mjs')], { encoding: 'utf8', env: { ...process.env, TEST_ALL_TIMEOUT_MS: '2000' } });
  assert.equal(run.status, 1);
  const out = run.stdout;
  assert.match(out, /^PASS test-good\.mjs/m);
  assert.match(out, new RegExp(`^ {5}skipped on ${process.platform}: no display on this machine$`, 'm'));
  assert.match(out, /^FAIL test-bad\.mjs \([\d.]+s, exit 1\)$/m);
  assert.match(out, /^FAIL test-hang\.mjs \([\d.]+s, (signal SIGTERM|exit null)\)$/m);
  assert.match(out, /^2 of 4 suite\(s\) failed$/m);
  assert.match(out, /^=== FAILURE DIGEST \(2 of 4 suite\(s\) failed; node v/m);
  assert.match(out, /^### test-bad\.mjs \(exit 1\)$/m);
  assert.match(out, /^### test-hang\.mjs \((signal SIGTERM|exit null)\)$/m);
  assert.match(out, /ETIMEDOUT/, 'a hung suite says it timed out');
  assert.match(out, /^\| .*one is not two: 50% of the time/m, 'the first failing assertion is in the digest');
  assert.ok(out.trimEnd().endsWith('=== END FAILURE DIGEST ==='));
  assert.ok(!out.split('\n').some((line) => line.trim().startsWith('::')), 'suite output can never become a workflow command in the Tests step');

  // ---- what the annotation step prints for that run ----------------------------------------------------------------
  const commands = buildAnnotations(out);
  assert.ok(commands.length <= 10, 'GitHub keeps 10 error annotations per step');
  assert.ok(commands.every((line) => line.startsWith('::error title=') && !line.includes('\n')), 'one line per command');
  assert.equal(commands[0], '::error title=test-all::2 of 4 suite(s) failed: test-bad.mjs, test-hang.mjs');
  assert.ok(commands.some((line) => line.startsWith('::error title=FAIL test-bad.mjs::FAIL test-bad.mjs (')), 'one error per FAIL line');
  assert.ok(commands.some((line) => line.startsWith('::error title=FAIL test-hang.mjs::FAIL test-hang.mjs (')));
  const digest = commands.find((line) => line.startsWith('::error title=test-bad.mjs (exit 1)::'));
  assert.ok(digest, 'one digest per failing suite');
  const message = unescape(digest.slice(digest.indexOf('::', 8) + 2));
  assert.match(message, /^first failure:\n/);
  assert.match(message, /AssertionError/);
  assert.match(message, /one is not two: 50% of the time/);
  assert.match(message, /last 15 lines:\n/);
  assert.ok(message.length <= 2900);
  assert.ok(commands.every((line) => line.length < 9000));

  // ---- limits and the crash case -----------------------------------------------------------------------------------------
  const many = ['PASS ok (1s)'];
  for (let index = 1; index <= 6; index += 1) many.push(`FAIL test-m${index}.mjs (1.0s, exit 1)`);
  many.push('6 of 7 suite(s) failed', '=== FAILURE DIGEST (6 of 7 suite(s) failed; node v22; win32 x64) ===');
  for (let index = 1; index <= 6; index += 1) many.push(`### test-m${index}.mjs (exit 1)`, 'first failure:', '| boom', 'last 15 lines:', '| boom');
  many.push('=== END FAILURE DIGEST ===');
  const capped = buildAnnotations(many.join('\n'));
  assert.ok(capped.length <= 10, `${capped.length} annotations for six failures`);
  assert.ok(capped.some((line) => line.includes('title=more failures') && line.includes('2 more suite(s) failed: test-m5.mjs, test-m6.mjs')));
  const crashed = buildAnnotations('PASS test-a.mjs (1s)\nsomething went wrong before the summary\n');
  assert.equal(crashed.length, 1);
  assert.match(crashed[0], /^::error title=test-all::no failure summary in the output; last lines:%0APASS test-a\.mjs \(1s\)%0Asomething went wrong/);

  // ---- the environment notice ---------------------------------------------------------------------------------------------
  const environment = await describeEnvironment({ ports: false });
  assert.match(environment[0], /^node v\d+\.\d+\.\d+ \S+ \S+ /);
  assert.ok(environment.some((line) => line.startsWith('tmpdir ')), 'the temp folder (8.3 short names show up here)');
  assert.ok(environment.some((line) => line.startsWith('git ')), 'git version and autocrlf');
  assert.ok(environment.some((line) => line.startsWith('directory symlink: ')));
  const freePort = await getFreePort();
  assert.equal(await portScan(freePort, freePort), `ports ${freePort}-${freePort} on 127.0.0.1: 1 ok`);

  // ---- the workflow wires it together -------------------------------------------------------------------------------------
  const workflow = readFileSync(join(here, '..', '.github', 'workflows', 'test.yml'), 'utf8');
  for (const needle of ['windows-latest', 'macos-latest', 'ubuntu-latest', 'fail-fast: false', 'timeout-minutes: 15', 'shell: bash', 'tee test-output.txt', 'PIPESTATUS', 'if: failure()', 'node scripts/ci-annotate.mjs test-output.txt', 'core.autocrlf false']) {
    assert.ok(workflow.includes(needle), `test.yml must contain ${needle}`);
  }
  console.log('ci-annotate test passed: escaping, digest, one annotation per failing suite within the 10-per-step limit, no command injection from suite output, hung suites, environment notice, workflow wiring.');
}, async () => {
  if (scratch) await removeDirectory(scratch);
});
