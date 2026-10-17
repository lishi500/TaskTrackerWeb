#!/usr/bin/env node
// Guards the agent-facing skill: size budget, frontmatter, links stay inside the skill
// directory, engine-neutral wording, and that the commands and endpoints it names exist.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skillDirectory = join(root, '.agents', 'skills', 'game-task-hub');
const skill = readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8');

// ---- budget and frontmatter ---------------------------------------------------------------
const lines = skill.replace(/\n$/, '').split('\n');
assert.ok(lines.length <= 80, `SKILL.md has ${lines.length} lines (limit 80)`);
assert.ok(Buffer.byteLength(skill) <= 6_000, `SKILL.md is ${Buffer.byteLength(skill)} bytes; it is read cold by every agent, keep it small`);
const frontmatter = /^---\nname: (.+)\ndescription: "(.+)"\n---\n/.exec(skill);
assert.ok(frontmatter, 'SKILL.md needs name and description frontmatter');
assert.equal(frontmatter[1], 'game-task-hub', 'name equals the folder name');
assert.ok(frontmatter[2].length <= 250, `description is ${frontmatter[2].length} characters (limit 250)`);
assert.match(frontmatter[2], /^Track and deliver/, 'the description leads with the use case');
assert.match(frontmatter[2], /Not for /, 'the description says what it is not for');

// ---- links stay inside the skill directory --------------------------------------------------
const files = [];
(function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path); else files.push(path);
  }
})(skillDirectory);
for (const file of files.filter((path) => path.endsWith('.md'))) {
  const text = readFileSync(file, 'utf8');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|#)/.test(target)) continue;
    const resolved = resolve(dirname(file), target.split('#')[0]);
    assert.ok(!relative(skillDirectory, resolved).startsWith('..'), `${relative(skillDirectory, file)} links outside the skill: ${target}`);
    assert.ok(existsSync(resolved), `${relative(skillDirectory, file)} links to a missing file: ${target}`);
  }
  assert.ok(!/[A-Za-z]:\\|\/Users\/|\.\.\//.test(text.replace(/`[^`]*`/g, '')) || file.endsWith('delivery-evidence.md'), `${relative(skillDirectory, file)} contains an absolute machine path or ../`);
  assert.ok(!/unity|cyberbudda/i.test(text), `${relative(skillDirectory, file)} still mentions Unity or CyberBudda (use engine-neutral wording)`);
}
for (const mentioned of skill.matchAll(/references\/([a-z-]+\.md)/g)) {
  assert.ok(existsSync(join(skillDirectory, 'references', mentioned[1])), `SKILL.md names references/${mentioned[1]} which does not exist`);
}

// ---- every `tt <command>` named in the skill is a real command --------------------------------
const help = spawnSync(process.execPath, [join(skillDirectory, 'scripts', 'tt.mjs'), 'help'], { encoding: 'utf8' }).stdout;
const known = new Set(['help']);
for (const line of help.split('\n')) for (const word of line.matchAll(/(?:^|[|\s])(up|down|url|doctor|status|ls|show|next|import|new|admit|park|block|unblock|start|event|art|done|review|issue)(?=[\s|[]|$)/g)) known.add(word[1]);
for (const [, command] of skill.matchAll(/`tt ([a-z]+)/g)) {
  assert.ok(known.has(command), `SKILL.md uses "tt ${command}", which is not a tt command`);
}
for (const command of ['next', 'start', 'event', 'done', 'review', 'import', 'new', 'ls', 'show', 'status', 'admit', 'park', 'block', 'unblock', 'art', 'issue', 'up', 'down', 'url', 'doctor']) {
  assert.ok(new RegExp(`\`tt ${command}\\b|tt ${command}\\b`).test(skill), `SKILL.md does not document tt ${command}`);
}

// ---- endpoints named in api.md exist in the server ----------------------------------------------
const server = readFileSync(join(root, 'server.mjs'), 'utf8');
const api = readFileSync(join(skillDirectory, 'references', 'api.md'), 'utf8');
const paths = new Set([...api.matchAll(/`(\/api\/[^`?\s[]+)/g)].map((match) => match[1]));
assert.ok(paths.size >= 20, `api.md names ${paths.size} endpoints`);
for (const path of paths) {
  const staticTail = path.split('/').filter((segment) => segment && !/^(ID|RUN|NAME|KEY)$/.test(segment)).pop();
  const needle = path.startsWith('/api/tasks/') || path.startsWith('/api/toolchain-issues/') ? staticTail : path;
  assert.ok(server.includes(needle), `api.md names ${path} but server.mjs has no ${needle}`);
}

// Every error code the server can send is documented for the agent.
const sent = new Set();
for (const line of server.split('\n')) {
  const match = /httpError\(\d{3}, .*, '([a-z]+(?:-[a-z]+)*)'\)/.exec(line);
  if (match) sent.add(match[1]);
}
assert.ok(sent.size >= 20, `found ${sent.size} error codes in server.mjs`);
for (const code of sent) assert.ok(api.includes(`\`${code}\``), `server.mjs sends error code ${code} but api.md does not document it`);

console.log(`skill test passed: ${lines.length} lines, ${Buffer.byteLength(skill)} bytes, description ${frontmatter[2].length} chars, links inside the skill, ${paths.size} endpoints and every tt command exist.`);
