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
  // a crash says nothing: the first run exits with an NTSTATUS code (Windows) or a truncated code (POSIX) and prints nothing;
  // the diagnostic rerun (its switches are visible in execArgv) fails in a way Node writes a report for
  writeFileSync(join(scripts, 'test-crash.mjs'), "if (process.execArgv.includes('--report-on-fatalerror')) {\n  setTimeout(() => { throw new Error('crash reproduced in the diagnostic rerun'); }, 10);\n} else {\n  process.exit(0xC0000409);\n}\n");
  const run = spawnSync(process.execPath, [join(scripts, 'test-all.mjs')], { encoding: 'utf8', env: { ...process.env, TEST_ALL_TIMEOUT_MS: '2000' } });
  assert.equal(run.status, 1);
  const out = run.stdout;
  assert.match(out, /^PASS test-good\.mjs/m);
  assert.match(out, new RegExp(`^ {5}skipped on ${process.platform}: no display on this machine$`, 'm'));
  assert.match(out, /^FAIL test-bad\.mjs \([\d.]+s, exit 1\)$/m);
  assert.match(out, /^FAIL test-hang\.mjs \([\d.]+s, (signal SIGTERM|exit null)\)$/m);
  assert.match(out, /^3 of 5 suite\(s\) failed$/m);
  assert.match(out, /^=== FAILURE DIGEST \(3 of 5 suite\(s\) failed; node v/m);
  assert.match(out, /^### test-bad\.mjs \(exit 1\)$/m);
  assert.match(out, /^### test-hang\.mjs \((signal SIGTERM|exit null)\)$/m);
  assert.match(out, /ETIMEDOUT/, 'a hung suite says it timed out');
  assert.match(out, /^FAIL test-crash\.mjs \([\d.]+s, exit (3221226505 = 0xC0000409|9)\)$/m, 'an NTSTATUS exit code is shown in hex');
  assert.match(out, /^ {5}crashed: rerun once with diagnostics -> exit 1, a report was written$/m);
  assert.match(out, /^### test-crash\.mjs \(exit (3221226505 = 0xC0000409|9)\)$/m);
  assert.equal(out.split('\n').filter((line) => line.startsWith('rerun with diagnostics:')).length, 1, 'only the crashed suite is rerun: not an assertion, not a hang');
  assert.match(out, /^rerun with diagnostics: exit 1$/m);
  assert.match(out, /^\| .*crash reproduced in the diagnostic rerun/m, 'what the rerun printed is in the digest');
  assert.match(out, /^\| +"event": "Exception",$/m, 'and the head of the report Node wrote');
  assert.match(out, /^\| .*one is not two: 50% of the time/m, 'the first failing assertion is in the digest');
  assert.ok(out.trimEnd().endsWith('=== END FAILURE DIGEST ==='));
  assert.ok(!out.split('\n').some((line) => line.trim().startsWith('::')), 'suite output can never become a workflow command in the Tests step');

  // ---- what the annotation step prints for that run ----------------------------------------------------------------
  const commands = buildAnnotations(out);
  assert.ok(commands.every((line) => /^::(error|warning) title=/.test(line) && !line.includes('\n')), 'one line per command');
  assert.ok(commands.filter((line) => line.startsWith('::error')).length <= 10 && commands.filter((line) => line.startsWith('::warning')).length <= 10, 'GitHub keeps 10 per level and step');
  assert.equal(commands[0], '::error title=test-all::3 of 5 suite(s) failed: test-bad.mjs, test-crash.mjs, test-hang.mjs');
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
  const rerun = commands.find((line) => line.startsWith('::warning title=test-crash.mjs rerun::'));
  const report = commands.find((line) => line.startsWith('::warning title=test-crash.mjs report::'));
  assert.ok(rerun && report, 'a crashed suite gets a rerun and a report annotation (warnings: their own quota)');
  const body = (line) => unescape(line.slice(line.indexOf('::', 10) + 2));
  assert.match(body(rerun), /^rerun with diagnostics: exit 1\nrerun output:\n.*crash reproduced in the diagnostic rerun/s);
  assert.match(body(report), /^report \(summary, then the first 40 lines\):\nevent Exception, trigger Exception\njavascript stack: Error: crash reproduced in the diagnostic rerun\n.*"event": "Exception"/s, 'the summary comes first, then the head of the report file');
  assert.ok(body(report).length <= 2900);
  assert.ok(!commands.some((line) => line.includes('title=test-bad.mjs rerun') || line.includes('title=test-hang.mjs rerun')), 'no rerun annotations for an assertion or a hang');

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
  for (const needle of ['windows-latest', 'macos-latest', 'ubuntu-latest', 'fail-fast: false', 'timeout-minutes: 15', 'shell: bash', 'tee test-output.txt', 'PIPESTATUS', 'if: failure()', 'node scripts/ci-annotate.mjs test-output.txt', 'core.autocrlf false', 'DIAGNOSTIC: fs.cpSync into a non-ASCII folder', 'continue-on-error: true', 'node scripts/ci-cpsync-repro.mjs', '::notice title=cpsync-repro::']) {
    assert.ok(workflow.includes(needle), `test.yml must contain ${needle}`);
  }
  // ---- the cpSync diagnostic runs, and our own copy works (the other variants are the thing being diagnosed) ------------
  const repro = spawnSync(process.execPath, [join(here, 'ci-cpsync-repro.mjs')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(repro.status, 0, repro.stderr);
  assert.match(repro.stdout, /^node v\d+\.\d+\.\d+ \S+ \S+$/m);
  for (const variant of ['cpSync', 'cpSyncAscii', 'cp', 'copyTree', 'rmSync']) assert.match(repro.stdout, new RegExp(`^${variant}: (exit \\d+|signal \\w+|could not run)`, 'm'), `a result line for ${variant}`);
  assert.match(repro.stdout, /^copyTree: exit 0 /m, 'the replacement copy works on every machine');

  console.log('ci-annotate test passed: escaping, digest, one annotation per failing suite within the 10-per-step limit, no command injection from suite output, hung suites, crashed suites rerun with diagnostics, environment notice, cpSync diagnostic, workflow wiring.');
}, async () => {
  if (scratch) await removeDirectory(scratch);
});
