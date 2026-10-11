#!/usr/bin/env node

import { lstat, mkdir, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = process.argv[2];
if (!gameRoot) throw new Error('Usage: node scripts/link-game-skill.mjs /absolute/path/to/game-repository');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, '.agents/skills/game-task-hub');
const destination = resolve(gameRoot, '.agents/skills/game-task-hub');
let destinationExists = true;
try { await lstat(destination); } catch (error) { if (error.code === 'ENOENT') destinationExists = false; else throw error; }
if (destinationExists) throw new Error(`${destination} already exists; refusing to replace it.`);
await mkdir(dirname(destination), { recursive: true });
await symlink(source, destination, 'dir');
console.log(`Linked ${destination} -> ${source}`);
