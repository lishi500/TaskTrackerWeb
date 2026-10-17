#!/usr/bin/env node
// Regression test for the Windows static-asset bug: resolve() returns
// backslash paths on Windows, the old containment test looked for "<dir>/" and
// answered 403 for /app.js and /styles.css (the dashboard rendered unstyled).

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as rawRequest } from 'node:http';
import { join } from 'node:path';
import { call, createSandbox, repoRoot, runSuite, startHub } from './lib/test-support.mjs';

const sandbox = await createSandbox('task-tracker-static-');
let hub;

// Plain http.request so ".." and backslashes reach the server unnormalized
// (fetch/URL collapse them client-side and would hide traversal bugs).
function raw(url, path) {
  const { hostname, port } = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const req = rawRequest({ hostname, port, path, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

await runSuite('static-assets', async () => {
  hub = await startHub({ trackerPath: sandbox.trackerPath });

  const expectedTypes = {
    '/': 'text/html; charset=utf-8',
    '/index.html': 'text/html; charset=utf-8',
    '/app.js': 'text/javascript; charset=utf-8',
    '/styles.css': 'text/css; charset=utf-8',
  };
  const onDisk = {
    '/': 'public/index.html', '/index.html': 'public/index.html', '/app.js': 'public/app.js', '/styles.css': 'public/styles.css',
  };
  for (const [path, contentType] of Object.entries(expectedTypes)) {
    const result = await call(hub.url, path);
    assert.equal(result.status, 200, `${path} must be served (got ${result.status})`);
    assert.equal(result.headers.get('content-type'), contentType, `${path} content type`);
    assert.equal(result.text, await readFile(join(repoRoot, onDisk[path]), 'utf8'), `${path} body must equal the file on disk`);
  }

  // Everything the dashboard page references must load (this is what "styled" means).
  const page = (await call(hub.url, '/')).text;
  const references = [...page.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((match) => match[1]);
  assert.ok(references.includes('styles.css') && references.includes('app.js'), 'index.html must reference styles.css and app.js');
  for (const reference of references) {
    assert.equal((await call(hub.url, `/${reference}`)).status, 200, `referenced asset ${reference} must load`);
  }

  // Unknown file, directory-ish and device-name paths are 404, never a crash.
  for (const path of ['/missing.js', '/nested/missing.css', '/NUL', '/CON']) {
    assert.equal((await raw(hub.url, path)).status, 404, `${path} must be 404`);
  }
  assert.ok([200, 404].includes((await raw(hub.url, '/app.js/')).status), 'a trailing slash on a file must not crash the server');

  // Case-insensitive filesystems (Windows) may serve /APP.JS; if they do, it must keep the JS type.
  const upper = await call(hub.url, '/APP.JS');
  if (upper.status === 200) assert.equal(upper.headers.get('content-type'), 'text/javascript; charset=utf-8');
  else assert.equal(upper.status, 404);

  // Traversal attempts must be refused and must never return server source.
  const traversal = [
    '/../server.mjs', '/..%2fserver.mjs', '/%2e%2e/server.mjs', '/..%5cserver.mjs', '/..\\server.mjs',
    '/public/../server.mjs', '/./../server.mjs', '//server.mjs', '/C:/Windows/win.ini', '/..', '/../',
  ];
  for (const path of traversal) {
    const result = await raw(hub.url, path);
    assert.ok([200, 400, 403, 404].includes(result.status), `${path} -> ${result.status}`);
    assert.ok(!result.body.includes('createServer') && !result.body.includes('[fonts]'), `${path} must not expose files outside public/`);
  }
  for (const path of ['/../server.mjs', '/..\\server.mjs', '//server.mjs']) {
    const result = await raw(hub.url, path);
    assert.ok([403, 404].includes(result.status), `${path} must be refused, got ${result.status}`);
  }

  console.log('static-assets test passed: dashboard assets load with correct types, unknown/device paths are 404, traversal is refused.');
}, async () => {
  await hub?.stop();
  await sandbox.dispose();
});
