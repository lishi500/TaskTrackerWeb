#!/usr/bin/env node
// Runs every scripts/test-*.mjs (except itself) one after another, each in its own
// node process, and prints one line per suite (plus a line per case that skipped itself on
// this OS). Exit code 1 if any suite fails. A failure ends with a compact digest (suite, first
// failing assertion, last 15 lines of its output); scripts/ci-annotate.mjs turns that into GitHub
// annotations, which are readable without logging in.
//   node scripts/test-all.mjs            run everything
//   node scripts/test-all.mjs tt http    run only suites whose name contains "tt" or "http"
//   TEST_ALL_TIMEOUT_MS=60000            per-suite time limit (default 300000: a hung suite fails with its output)
//
// A suite (or a case inside one) that cannot run on this OS or machine prints "SKIP: reason"
// (skipNote / skipSuite in scripts/lib/test-support.mjs); it is listed here so nobody mistakes
// it for coverage. Everything else must pass on Windows, macOS and Linux alike.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const suites = readdirSync(directory)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-all.mjs')
  .filter((name) => !filters.length || filters.some((filter) => name.includes(filter)))
  .sort();

// Every line of failure output carries a "| " gutter: a line that starts with "::" would be taken for a GitHub
// workflow command, and the runner ignores leading spaces when it looks for one.
const gutter = (line) => `| ${String(line).replace(/\r$/, '').slice(0, 400)}`;
const FIRST_FAILURE = /\b(FAILED|AssertionError|TypeError|ReferenceError|SyntaxError|ERR_[A-Z_]+|Error:)/;

function digestOf(failure) {
  const lines = `${failure.stdout}${failure.stderr}`.split('\n').map((line) => line.replace(/\r$/, ''));
  const firstIndex = lines.findIndex((line) => FIRST_FAILURE.test(line));
  const first = firstIndex < 0 ? [] : lines.slice(firstIndex, firstIndex + 5).filter((line) => line.trim() !== '');
  const exit = failure.signal ? `signal ${failure.signal}` : `exit ${failure.status}`;
  return [
    `### ${failure.suite} (${exit})`,
    ...(failure.error ? [gutter(`could not run: ${failure.error}`)] : []),
    'first failure:',
    ...(first.length ? first.map(gutter) : [gutter('(no assertion text found in the output)')]),
    'last 15 lines:',
    ...lines.filter((line) => line.trim() !== '').slice(-15).map(gutter),
  ];
}

console.log(`node ${process.version} on ${process.platform} ${process.arch} | tmp ${tmpdir()}${process.env.CI ? ' | CI' : ''}`);
let failed = 0;
let skipped = 0;
const failures = [];
for (const suite of suites) {
  const started = Date.now();
  // maxBuffer: a chatty failure must not be mistaken for a crash; timeout: a hung suite becomes a failure with output.
  const result = spawnSync(process.execPath, [join(directory, suite)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: Number(process.env.TEST_ALL_TIMEOUT_MS) || 300_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASS ${suite} (${seconds}s)`);
    for (const line of result.stdout.split(/\r?\n/).filter((candidate) => candidate.startsWith('SKIP: '))) {
      skipped += 1;
      console.log(`     skipped on ${process.platform}: ${line.slice('SKIP: '.length)}`);
    }
  } else {
    failed += 1;
    console.log(`FAIL ${suite} (${seconds}s, ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`);
    console.log(`${result.stdout}${result.stderr}`.trim().split('\n').slice(-15).map((line) => `     ${gutter(line)}`).join('\n'));
    failures.push({ suite, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  }
}
const skippedNote = skipped ? `, ${skipped} case(s) skipped on ${process.platform} (reasons above)` : '';
console.log(failed ? `${failed} of ${suites.length} suite(s) failed` : `all ${suites.length} suite(s) passed${skippedNote}`);
if (failures.length) {
  console.log(`=== FAILURE DIGEST (${failed} of ${suites.length} suite(s) failed; node ${process.version}; ${process.platform} ${process.arch}) ===`);
  for (const failure of failures) console.log(digestOf(failure).join('\n'));
  console.log('=== END FAILURE DIGEST ===');
}
process.exit(failed ? 1 : 0);
