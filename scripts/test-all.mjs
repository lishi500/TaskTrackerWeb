#!/usr/bin/env node
// Runs every scripts/test-*.mjs (except itself) one after another, each in its own
// node process, and prints one line per suite. Exit code 1 if any suite fails.
//   node scripts/test-all.mjs            run everything
//   node scripts/test-all.mjs tt http    run only suites whose name contains "tt" or "http"

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);
const suites = readdirSync(directory)
  .filter((name) => /^test-.*\.mjs$/.test(name) && name !== 'test-all.mjs')
  .filter((name) => !filters.length || filters.some((filter) => name.includes(filter)))
  .sort();

let failed = 0;
for (const suite of suites) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [join(directory, suite)], { encoding: 'utf8' });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`PASS ${suite} (${seconds}s)`);
  } else {
    failed += 1;
    console.log(`FAIL ${suite} (${seconds}s, exit ${result.status})`);
    console.log(`${result.stdout}${result.stderr}`.trim().split('\n').slice(-15).map((line) => `     ${line}`).join('\n'));
  }
}
console.log(failed ? `${failed} of ${suites.length} suite(s) failed` : `all ${suites.length} suite(s) passed`);
process.exit(failed ? 1 : 0);
