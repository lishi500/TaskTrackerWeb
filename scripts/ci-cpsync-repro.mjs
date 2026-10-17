#!/usr/bin/env node
// DIAGNOSTIC for CI, not a test. Reproduces, outside the Hub's own code, a crash seen once on a Windows runner:
// test-discovery died with exit code 0xC0000409 and no output, right where it called fs.cpSync into a folder
// named "Hub discovery <two CJK characters> " (non-ASCII characters and spaces).
//
//   node scripts/ci-cpsync-repro.mjs              driver: runs every variant in its own process, prints one line each
//   node scripts/ci-cpsync-repro.mjs cpSync       one variant: cpSync | cpSyncAscii | cp | copyTree | rmSync
//
// One process per variant, so a native crash in one cannot hide the others. The progress markers are written with
// writeSync, so they survive a crash. The driver also prints the Node version and, on Windows, the ANSI code page
// (a CJK system can hold the characters, an English one cannot).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree } from './lib/copy-tree.mjs';

// cpSyncAscii is the control: the same fs.cpSync into a folder with an ASCII name.
const variants = ['cpSync', 'cpSyncAscii', 'cp', 'copyTree', 'rmSync'];
const say = (text) => writeSync(1, `${text}\n`);

function describeExit(result) {
  if (result.error) return `could not run (${result.error.code ?? result.error.message})`;
  if (result.signal) return `signal ${result.signal}`;
  return result.status >= 0x80000000 ? `exit ${result.status} = 0x${result.status.toString(16).toUpperCase()}` : `exit ${result.status}`;
}

if (!process.argv[2]) {
  const lines = [`node ${process.version} ${process.platform} ${process.arch}`];
  if (process.platform === 'win32') {
    const acp = spawnSync('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    lines.push(`ANSI code page: ${/ACP\s+REG_SZ\s+(\d+)/.exec(acp.stdout ?? '')?.[1] ?? 'unknown'}; locale ${Intl.DateTimeFormat().resolvedOptions().locale}`);
  }
  for (const variant of variants) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), variant], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\r/g, '').trim().split('\n').filter(Boolean).slice(-6).join(' / ');
    lines.push(`${variant}: ${describeExit(result)} after ${((Date.now() - started) / 1000).toFixed(1)}s${output ? ` | ${output}` : ' | (no output)'}`);
  }
  console.log(lines.join('\n'));
} else {
  const variant = process.argv[2];
  if (!variants.includes(variant)) {
    console.error(`unknown variant '${variant}' (use ${variants.join(' | ')})`);
    process.exit(2);
  }
  say(`start ${variant}`);
  const base = mkdtempSync(join(tmpdir(), variant === 'cpSyncAscii' ? 'Hub discovery ascii ' : `Hub discovery ${String.fromCharCode(0x53D1, 0x73B0)} `));
  say('folder created');
  const source = join(base, 'source');
  mkdirSync(join(source, 'nested'), { recursive: true });
  writeFileSync(join(source, 'nested', 'file.txt'), 'hello');
  const target = join(base, 'Fish Game', '.claude', 'skills', 'game-task-hub');
  mkdirSync(dirname(target), { recursive: true });
  say(`before ${variant} in ${base}`);
  if (variant === 'cpSync' || variant === 'cpSyncAscii') cpSync(source, target, { recursive: true });
  else if (variant === 'cp') await cp(source, target, { recursive: true });
  else if (variant === 'copyTree') copyTree(source, target);
  else rmSync(source, { recursive: true, force: true });
  say(`after ${variant} ${variant === 'rmSync' ? `source exists: ${existsSync(source)}` : `copy exists: ${existsSync(join(target, 'nested', 'file.txt'))}`}`);
}
