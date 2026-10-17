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
// A suite that CRASHED (a signal, a Windows NTSTATUS exit code such as 0xC0000409, or a failure that printed
// nothing at all) says nothing useful the first time, so it is run once more on its own with
// `node --report-on-fatalerror --report-uncaught-exception --trace-uncaught` and the digest carries what that
// run printed plus the first 40 lines of any diagnostic report Node wrote.
//
// A suite (or a case inside one) that cannot run on this OS or machine prints "SKIP: reason"
// (skipNote / skipSuite in scripts/lib/test-support.mjs); it is listed here so nobody mistakes
// it for coverage. Everything else must pass on Windows, macOS and Linux alike.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
const maxBuffer = 64 * 1024 * 1024; // a chatty failure must not be mistaken for a crash

function describeExit(result) {
  if (result.signal) return `signal ${result.signal}`;
  // Windows reports NTSTATUS codes (0xC0000409 = fast fail / abort) as large positive numbers
  if (result.status >= 0x80000000) return `exit ${result.status} = 0x${result.status.toString(16).toUpperCase()}`;
  return `exit ${result.status}`;
}

const timedOut = (result) => result.error?.code === 'ETIMEDOUT';
const isCrash = (result) => !timedOut(result)
  && (Boolean(result.signal) || result.status >= 0x80000000 || (result.status !== 0 && !`${result.stdout}${result.stderr}`.trim()));

// The same suite once more, alone, with Node's diagnostic switches; report = first 40 lines of the file Node wrote.
function rerunWithDiagnostics(suite) {
  const reportDirectory = mkdtempSync(join(tmpdir(), 'crash-report-'));
  const flags = ['--report-on-fatalerror', '--report-uncaught-exception', '--trace-uncaught', `--report-directory=${reportDirectory}`, '--report-filename=crash-report.json'];
  const result = spawnSync(process.execPath, [...flags, join(directory, suite)], { encoding: 'utf8', maxBuffer, timeout: 120_000 });
  let report = [];
  try {
    const raw = readFileSync(join(reportDirectory, 'crash-report.json'), 'utf8');
    // The parts that matter for a crash sit far below the 40-line header, so they are summarised first.
    let summary = [];
    try {
      const parsed = JSON.parse(raw);
      summary = [
        `event ${parsed.header?.event}, trigger ${parsed.header?.trigger}`,
        ...(parsed.javascriptStack ? [`javascript stack: ${parsed.javascriptStack.message ?? ''}`, ...(parsed.javascriptStack.stack ?? []).slice(0, 8)] : []),
        ...(Array.isArray(parsed.nativeStack) && parsed.nativeStack.length ? ['native stack:', ...parsed.nativeStack.slice(0, 12).map((frame) => `${frame.pc ?? ''} ${frame.symbol ?? ''}`.trim())] : []),
        '--- the first 40 lines of the report file ---',
      ];
    } catch { /* not JSON (cut off by the crash): the raw lines below still show it */ }
    report = [...summary, ...raw.split('\n').map((line) => line.replace(/\r$/, '')).slice(0, 40)];
  } catch { /* nothing written: a native crash that bypasses Node usually leaves no report */ }
  try { rmSync(reportDirectory, { recursive: true, force: true }); } catch { /* a temp folder, never a failure */ }
  return {
    exit: result.error && !result.status && !result.signal ? `could not run (${result.error.code ?? result.error.message})` : describeExit(result),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '').slice(-30),
    report,
  };
}

function digestOf(failure) {
  const lines = `${failure.stdout}${failure.stderr}`.split('\n').map((line) => line.replace(/\r$/, ''));
  const firstIndex = lines.findIndex((line) => FIRST_FAILURE.test(line));
  const first = firstIndex < 0 ? [] : lines.slice(firstIndex, firstIndex + 5).filter((line) => line.trim() !== '');
  const digest = [
    `### ${failure.suite} (${failure.exit})`,
    ...(failure.error ? [gutter(`could not run: ${failure.error}`)] : []),
    'first failure:',
    ...(first.length ? first.map(gutter) : [gutter('(no assertion text found in the output)')]),
    'last 15 lines:',
    ...lines.filter((line) => line.trim() !== '').slice(-15).map(gutter),
  ];
  if (failure.rerun) {
    digest.push(`rerun with diagnostics: ${failure.rerun.exit}`, 'rerun output:');
    digest.push(...(failure.rerun.output.length ? failure.rerun.output.map(gutter) : [gutter('(no output)')]));
    digest.push('report (summary, then the first 40 lines):');
    digest.push(...(failure.rerun.report.length ? failure.rerun.report.map(gutter) : [gutter('(no report file was written)')]));
  }
  return digest;
}

console.log(`node ${process.version} on ${process.platform} ${process.arch} | tmp ${tmpdir()}${process.env.CI ? ' | CI' : ''}`);
let failed = 0;
let skipped = 0;
const failures = [];
for (const suite of suites) {
  const started = Date.now();
  // timeout: a hung suite becomes a failure with its output instead of a job that never ends.
  const result = spawnSync(process.execPath, [join(directory, suite)], { encoding: 'utf8', maxBuffer, timeout: Number(process.env.TEST_ALL_TIMEOUT_MS) || 300_000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASS ${suite} (${seconds}s)`);
    for (const line of result.stdout.split(/\r?\n/).filter((candidate) => candidate.startsWith('SKIP: '))) {
      skipped += 1;
      console.log(`     skipped on ${process.platform}: ${line.slice('SKIP: '.length)}`);
    }
  } else {
    failed += 1;
    const exit = describeExit(result);
    console.log(`FAIL ${suite} (${seconds}s, ${exit})`);
    console.log(`${result.stdout}${result.stderr}`.trim().split('\n').slice(-15).map((line) => `     ${gutter(line)}`).join('\n'));
    const failure = { suite, exit, error: result.error?.message, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    if (isCrash(result)) {
      failure.rerun = rerunWithDiagnostics(suite);
      console.log(`     crashed: rerun once with diagnostics -> ${failure.rerun.exit}${failure.rerun.report.length ? ', a report was written' : ''}`);
    }
    failures.push(failure);
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
