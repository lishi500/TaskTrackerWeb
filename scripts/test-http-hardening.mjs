#!/usr/bin/env node
// HTTP contract for agents and Windows: Origin aliases, Host (DNS rebinding)
// guard, specific 4xx errors instead of 500s (null body, bad %-encoding,
// unknown dependency, missing artifact/run, missing agent/reviewer fields),
// revision required vs stale, artifact and static response headers.

import assert from 'node:assert/strict';
import { request as rawRequest } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { call, createSandbox, mutation, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const sandbox = await createSandbox('task-tracker-hardening-', [
  taskRow({ TaskID: 'H-001', Status: 'Ready' }),
  taskRow({ TaskID: 'H-002', Status: 'Backlog', DependsOn: 'H-001' }),
  taskRow({ TaskID: 'S-001', Status: 'Ready' }),
]);
let hub;
let url;

const revision = async () => (await call(url, '/api/dependency-audit')).body.revision;
const post = async (path, payload, headers) => call(url, path, mutation(url, { trackerRevision: await revision(), ...payload }, headers));
const newTask = (taskId, extra = {}) => ({
  taskId, taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'Test', task: `Created ${taskId}`, specRef: 'README.md',
  dependsOn: '', ownerRole: 'Agent', priority: 'P1', acceptance: 'Observable.', completionAuthority: 'IndependentReviewerAgent', ...extra,
});
const create = (taskId, extra, headers) => post('/api/tasks', { agent: 'planner', reason: 'fixture', newTask: newTask(taskId, extra) }, headers);

// Raw request so we control the Host header and the exact bytes (fetch overrides both).
function raw({ method = 'GET', path = '/', headers = {}, body }) {
  const { hostname, port } = new URL(url);
  return new Promise((resolveResponse, reject) => {
    const req = rawRequest({ hostname, port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON */ }
        resolveResponse({ status: res.statusCode, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

await runSuite('http-hardening', async () => {
  hub = await startHub({ trackerPath: sandbox.trackerPath });
  url = hub.url;
  const { port } = new URL(url);

  // ---- Origin: every loopback spelling of this port is accepted ----------------------------
  for (const [index, origin] of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].entries()) {
    const result = await create(`ORI-${index}`, {}, { Origin: origin });
    assert.equal(result.status, 201, `${origin} must be accepted: ${JSON.stringify(result.body)}`);
  }
  for (const origin of [`http://evil.example:${port}`, 'http://localhost:9999', 'http://127.0.0.1', `https://127.0.0.1:${port}`, 'null', `http://127.0.0.1.evil.example:${port}`]) {
    const result = await create('ORI-BAD', {}, { Origin: origin });
    assert.equal(result.status, 403, `${origin} must be rejected`);
    assert.equal(result.body.code, 'origin');
  }
  let result = await call(url, '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trackerRevision: await revision() }) });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /Origin header is missing: send "Origin: http:\/\/127\.0\.0\.1:\d+"/);
  result = await call(url, '/api/tasks', { method: 'POST', headers: { Origin: url }, body: '{}' });
  assert.equal(result.status, 415);

  // ---- Host guard (DNS rebinding) ----------------------------------------------------------
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1.evil.example:${port}`, `localhost.evil.example:${port}`, '10.0.0.5']) {
    for (const path of ['/api/instance', '/', '/api/dependency-audit']) {
      const hostile = await raw({ path, headers: { Host: host } });
      assert.equal(hostile.status, 403, `Host '${host}' on ${path} must be refused (got ${hostile.status})`);
      assert.equal(hostile.body.code, 'host');
      assert.ok(!hostile.text.includes('projectId'), 'a refused host must not receive data');
    }
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, '127.1']) {
    assert.equal((await raw({ path: '/api/instance', headers: { Host: host } })).status, 200, `Host '${host}' must be accepted`);
  }

  // ---- Body hardening: no 500 for client mistakes ------------------------------------------
  const json = { 'Content-Type': 'application/json', Origin: url };
  const bodyCases = [
    ['null', 'null', 400, 'bad-body', /must be a JSON object/],
    ['array', '[]', 400, 'bad-body', /must be a JSON object/],
    ['number', '5', 400, 'bad-body', /must be a JSON object/],
    ['string', '"x"', 400, 'bad-body', /must be a JSON object/],
    ['empty', '', 400, 'bad-body', /empty/],
    ['truncated', '{"taskId":', 400, 'bad-json', /valid JSON/],
  ];
  for (const [label, body, status, code, pattern] of bodyCases) {
    const response = await raw({ method: 'POST', path: '/api/runs/start', headers: json, body });
    assert.equal(response.status, status, `${label}: ${response.text}`);
    assert.equal(response.body.code, code, label);
    assert.match(response.body.error, pattern, label);
  }
  const badUtf8 = await raw({ method: 'POST', path: '/api/runs/start', headers: json, body: Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]) });
  assert.equal(badUtf8.status, 400);
  assert.equal(badUtf8.body.code, 'bad-encoding');
  assert.match(badUtf8.body.error, /not valid UTF-8/);
  // A UTF-8 BOM in front of valid JSON (PowerShell Out-File -Encoding utf8) is tolerated.
  const withBom = await raw({ method: 'POST', path: '/api/runs/start', headers: json, body: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('{"taskId":"H-001"}')]) });
  assert.equal(withBom.status, 400);
  assert.equal(withBom.body.code, 'missing-field', 'BOM-prefixed JSON must parse and reach field validation');

  // ---- URL decoding ----------------------------------------------------------------------------
  for (const [method, path] of [['GET', '/api/tasks/%E0%A4%A/packet'], ['GET', '/api/tasks/%zz/runs'], ['GET', '/api/tasks/H-001/runs/%/artifacts/a'], ['POST', '/api/tasks/%E0%A4%A/admit'], ['POST', '/api/toolchain-issues/%E0/ack'], ['POST', '/api/tasks/H-001/runs/%/close']]) {
    const response = await raw({ method, path, headers: method === 'POST' ? json : {}, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 400, `${method} ${path} -> ${response.status} ${response.text}`);
    assert.equal(response.body.code, 'bad-url');
  }

  // ---- Revision: required (400) vs stale (409) ---------------------------------------------------
  const noRevision = await call(url, '/api/tasks', mutation(url, { agent: 'planner', reason: 'fixture', newTask: newTask('REV-1') }));
  assert.equal(noRevision.status, 400);
  assert.equal(noRevision.body.code, 'revision-required');
  assert.match(noRevision.body.error, /^trackerRevision is required/);
  const current = await revision();
  const stale = await call(url, '/api/tasks', mutation(url, { trackerRevision: 'deadbeef', agent: 'planner', reason: 'fixture', newTask: newTask('REV-1') }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'revision-stale');
  assert.ok(stale.body.error.startsWith(`trackerRevision is stale (current: ${current})`), stale.body.error);

  // ---- Missing identity / fields name what is missing ----------------------------------------
  result = await post('/api/tasks', { reason: 'fixture', newTask: newTask('FLD-1') });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /^agent is required/);
  result = await post('/api/tasks/H-001/review', { action: 'claim' });
  assert.match(result.body.error, /^reviewer is required/);
  result = await post('/api/tasks/H-001/admit', { targetStatus: 'Ready', reason: 'x' });
  assert.match(result.body.error, /^agent is required/);
  result = await post('/api/tasks/H-001/park', { agent: 'a' });
  assert.equal(result.status, 400);
  result = await post('/api/runs/start', { taskId: 'H-001', agent: 'a', verificationProfile: 'logic' });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Missing required field\(s\): scope, expectedBehavior\./);
  result = await post('/api/runs/start', { agent: 'a', verificationProfile: 'l', scope: 's', expectedBehavior: 'e' });
  assert.match(result.body.error, /^taskId is required/);

  // ---- Dependencies: ';' separator, unknown ids, self ----------------------------------------------
  result = await create('DEP-1', { dependsOn: 'NOPE-1' });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'unknown-dependency');
  assert.match(result.body.error, /Unknown dependency TaskID\(s\): NOPE-1\. dependsOn is a ';'-separated list/);
  result = await create('DEP-1', { dependsOn: 'H-001,H-002' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'invalid-dependency');
  assert.match(result.body.error, /Separate multiple dependencies with ';'/);
  result = await create('DEP-1', { dependsOn: 'H-001 H-002' });
  assert.match(result.body.error, /Separate multiple dependencies with ';'/);
  result = await create('DEP-1', { dependsOn: 'DEP-1' });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /self dependency/);
  result = await create('DEP-1', { dependsOn: 'H-001;H-002' });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  result = await post('/api/tasks/DEP-1/dependencies', { agent: 'a', reason: 'r', dependsOn: 'NOPE-9' });
  assert.equal(result.status, 422, 'unknown dependency on revision was a 500 before');
  assert.equal(result.body.code, 'unknown-dependency');
  result = await post('/api/tasks/DEP-1/dependencies', { agent: 'a', reason: 'r', dependsOn: 'H-001;ALSO,BAD' });
  assert.equal(result.status, 400);

  // ---- Missing run / artifact are 404, never a raw filesystem error --------------------------------
  result = await call(url, '/api/tasks/H-001/runs/H-001-R0001/artifacts/none.txt');
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'artifact-not-found');
  assert.ok(!/[A-Za-z]:\\|task-records/.test(result.text), 'no filesystem path in the message');
  assert.equal((await call(url, '/api/tasks/H-001/runs/H-001-R0009')).body.code, 'run-not-found');
  for (const operation of ['events', 'artifacts', 'close']) {
    result = await post(`/api/tasks/H-001/runs/H-001-R0009/${operation}`, { type: 't', result: 'r', message: 'm', name: 'n', content: 'c', outcome: 'verified', summary: 's' });
    assert.equal(result.status, 404, operation);
    assert.equal(result.body.code, 'run-not-found');
  }
  assert.equal((await call(url, '/api/tasks/NOPE-1/runs/NOPE-1-R0001')).status, 404);

  // ---- Real run: artifact headers, field errors on a live run -----------------------------------------
  const started = await post('/api/runs/start', { taskId: 'H-001', agent: 'impl', verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const runId = started.body.run.runId;
  result = await post(`/api/tasks/H-001/runs/${runId}/events`, { type: 'note', result: 'ok' });
  assert.match(result.body.error, /Missing required field\(s\): message\./);
  result = await post(`/api/tasks/H-001/runs/${runId}/artifacts`, { content: 'x' });
  assert.match(result.body.error, /Missing required field: name\./);
  result = await post(`/api/tasks/H-001/runs/${runId}/artifacts`, { name: 'big.txt', content: 'x'.repeat(131_073) });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /131073 bytes; the limit is 128 KB/);
  for (const [name, expectedType] of [['page.html', 'text/plain; charset=utf-8'], ['image.svg', 'text/plain; charset=utf-8'], ['doc.xml', 'text/plain; charset=utf-8'], ['data.json', 'application/json; charset=utf-8'], ['notes.md', 'text/markdown; charset=utf-8']]) {
    result = await post(`/api/tasks/H-001/runs/${runId}/artifacts`, { name, content: name.endsWith('.json') ? '{"a":1}' : `<script>alert('${name}')</script>` });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const served = await call(url, `/api/tasks/H-001/runs/${runId}/artifacts/${name}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), expectedType, name);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(served.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  }
  result = await post(`/api/tasks/H-001/runs/${runId}/close`, { outcome: 'done', summary: 's' });
  assert.match(result.body.error, /^outcome must be verified, blocked, awaiting-human or incomplete \(got 'done'\)/);
  result = await post(`/api/tasks/H-001/runs/${runId}/close`, { outcome: 'verified' });
  assert.match(result.body.error, /^summary is required/);

  // ---- Unexpected failures: 500 without absolute paths --------------------------------------------------
  await mkdir(join(sandbox.dir, 'task-records'), { recursive: true });
  await writeFile(join(sandbox.dir, 'task-records', 'S-001'), 'a file where the task folder should be');
  result = await post('/api/runs/start', { taskId: 'S-001', agent: 'impl', verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /^ENOTDIR: the tracker could not complete a file operation/);
  assert.ok(!result.text.includes(sandbox.dir) && !/[A-Za-z]:[\\/]/.test(result.text) && !result.text.includes('task-records'), `500 body leaked a path: ${result.text}`);
  assert.ok(hub.stderr.some((line) => /ENOTDIR/.test(line)), 'the full error stays in the server log');

  // ---- Unknown endpoints and methods ----------------------------------------------------------------------
  result = await call(url, '/api/nope');
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'unknown-endpoint');
  result = await call(url, '/api/nope', mutation(url, {}));
  assert.equal(result.status, 404);
  result = await call(url, '/api/tasks/H-001/review');
  assert.equal(result.status, 404, 'GET on a POST-only route');
  result = await raw({ method: 'DELETE', path: '/api/tasks' });
  assert.equal(result.status, 405);
  result = await raw({ method: 'PUT', path: '/' });
  assert.equal(result.status, 405);

  // ---- Static page security headers -------------------------------------------------------------------------
  const page = await call(url, '/');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

  console.log('http-hardening test passed: Origin aliases, Host guard, no-500 client errors, named fields, revision required/stale, safe artifact and error responses.');
}, async () => {
  await hub?.stop();
  await sandbox.dispose();
});
