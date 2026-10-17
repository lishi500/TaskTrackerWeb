#!/usr/bin/env node
// CI helper (not a test): turn the output of `node scripts/test-all.mjs` into GitHub Actions workflow
// commands. The job log needs a login to read, but annotations are public:
//   GET https://api.github.com/repos/<owner>/<repo>/check-runs/<job id>/annotations
//
//   node scripts/ci-annotate.mjs test-output.txt
//
// One ::error per failing suite from the "FAIL ..." summary lines, one per failing suite from the failure
// digest (first failing assertion + last 15 lines of its output), one overall error, and a ::notice that
// describes the machine (OS, user, temp folder, git, symlinks, bindable ports) because "passes here, fails
// on the runner" is almost always about the machine. GitHub allows 10 error annotations per step, so at
// most 4 suites get a digest and a FAIL line.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Workflow-command escaping: the data part escapes % CR LF; a property (title) also escapes : and ,
export const escapeData = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
export const escapeProperty = (text) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

// Keep the start (what failed) and the end (where it stopped) of an over-long message.
export const clipMessage = (text, limit = 2900) => {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, 900)}\n...\n${value.slice(-(limit - 905))}`;
};

export const command = (level, title, message, limit = 2900) => `::${level} title=${escapeProperty(title)}::${escapeData(clipMessage(message, limit))}`;

const ungutter = (line) => line.replace(/^\s*\| ?/, '');

// text = the whole output of test-all.mjs. Returns the workflow commands to print.
export function buildAnnotations(text) {
  const lines = String(text).split(/\r?\n/);
  const failLines = lines.filter((line) => /^FAIL \S+ \(/.test(line));
  const summary = lines.find((line) => /^\d+ of \d+ suite\(s\) failed$/.test(line));
  const commands = [];
  if (summary || failLines.length) {
    const names = failLines.map((line) => line.split(' ')[1]);
    commands.push(command('error', 'test-all', `${summary ?? `${failLines.length} suite(s) failed`}: ${names.join(', ')}`));
  }
  for (const line of failLines.slice(0, 4)) commands.push(command('error', `FAIL ${line.split(' ')[1]}`, line));

  const start = lines.findIndex((line) => line.startsWith('=== FAILURE DIGEST'));
  if (start >= 0) {
    const end = lines.findIndex((line, index) => index > start && line.startsWith('=== END FAILURE DIGEST'));
    const blocks = [];
    for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
      if (line.startsWith('### ')) blocks.push({ title: line.slice(4), lines: [] });
      else blocks.at(-1)?.lines.push(ungutter(line));
    }
    for (const block of blocks.slice(0, 4)) commands.push(command('error', block.title, block.lines.join('\n')));
    if (blocks.length > 4) commands.push(command('error', 'more failures', `${blocks.length - 4} more suite(s) failed: ${blocks.slice(4).map((block) => block.title.split(' ')[0]).join(', ')}`));
  }

  if (!commands.length) {
    // test-all never printed its summary: the step crashed or was cut off. Show where it stopped.
    commands.push(command('error', 'test-all', `no failure summary in the output; last lines:\n${lines.filter((line) => line.trim()).slice(-40).join('\n')}`));
  }
  return commands;
}

// Which bindable ports does this machine leave us? (Windows reserves ranges for Hyper-V, WSL2 and Docker.)
export async function portScan(from = 4300, to = 4999) {
  const counts = {};
  const odd = [];
  for (let port = from; port <= to; port += 1) {
    const code = await new Promise((resolveCode) => {
      const probe = createServer();
      probe.once('error', (error) => resolveCode(error.code ?? 'ERR'));
      probe.once('listening', () => probe.close(() => resolveCode('ok')));
      probe.listen(port, '127.0.0.1');
    });
    counts[code] = (counts[code] ?? 0) + 1;
    if (code !== 'ok' && odd.length < 12) odd.push(`${port}:${code}`);
  }
  return `ports ${from}-${to} on 127.0.0.1: ${Object.entries(counts).map(([code, count]) => `${count} ${code}`).join(', ')}${odd.length ? ` (${odd.join(' ')})` : ''}`;
}

export async function describeEnvironment({ ports = true } = {}) {
  const run = (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : `(${result.error?.code ?? `exit ${result.status}`})`;
  };
  const temp = os.tmpdir();
  let real = '?';
  try { real = realpathSync.native(temp); } catch { /* keep ? */ }
  const lines = [
    `node ${process.version} ${process.platform} ${process.arch} ${os.release()}; ${os.cpus().length} cpu; ${Math.round(os.freemem() / 1_048_576)} of ${Math.round(os.totalmem() / 1_048_576)} MB free`,
    `user ${os.userInfo().username}${process.platform === 'win32' ? `; elevated: ${spawnSync('fsutil', ['dirty', 'query', process.env.SystemDrive ?? 'C:'], { windowsHide: true, timeout: 10_000 }).status === 0}` : ''}; host ${os.hostname()}`,
    `tmpdir ${temp}${real !== temp ? ` (real path ${real})` : ''}; cwd ${process.cwd()}`,
    `CI=${process.env.CI ?? ''}; shell ${process.env.SHELL ?? process.env.ComSpec ?? ''}`,
    `${run('git', ['--version'])}; core.autocrlf ${run('git', ['config', '--show-origin', '--get-all', 'core.autocrlf']).replace(/\s+/g, ' ')}; user.name ${run('git', ['config', 'user.name'])}`,
  ];
  // Can an ordinary directory symlink be created here? (An administrator can; a normal Windows user cannot.)
  let link = '';
  try {
    const folder = mkdtempSync(join(temp, 'ci-probe-'));
    link = `${folder}-link`;
    symlinkSync(folder, link, 'dir');
    lines.push('directory symlink: created');
  } catch (error) {
    lines.push(`directory symlink: ${error.code ?? error.message}`);
  } finally {
    if (link) { try { unlinkSync(link); } catch { try { rmdirSync(link); } catch { /* leave it */ } } }
  }
  if (ports) lines.push(await portScan());
  return lines;
}

async function main() {
  const file = process.argv[2] ?? 'test-output.txt';
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* reported below */ }
  const commands = text.trim() ? buildAnnotations(text) : [command('error', 'test-all', `${file} is empty or missing: the Tests step failed before test-all printed anything`)];
  for (const line of commands) console.log(line);
  try {
    console.log(command('notice', 'ci-environment', (await describeEnvironment()).join('\n')));
  } catch (error) {
    console.log(command('notice', 'ci-environment', `could not describe the environment: ${error?.message ?? error}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
