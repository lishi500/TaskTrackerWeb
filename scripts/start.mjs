#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'server.mjs')], {
  cwd: root,
  env: { ...process.env, HOST: process.env.HOST ?? '127.0.0.1', PORT: process.env.PORT ?? '0' },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
