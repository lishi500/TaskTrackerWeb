#!/usr/bin/env node
// Agent-facing read endpoints: GET /api/health, GET /api/tasks (filters),
// GET /api/next (claimable task, or what holds the lane and which command moves it).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { call, createSandbox, mutation, runSuite, startHub, taskRow } from './lib/test-support.mjs';

const hubs = [];
const sandboxes = [];

async function withHub(rows, env, body) {
  const sandbox = await createSandbox('task-tracker-agentapi-', rows);
  sandboxes.push(sandbox);
  const hub = await startHub({ trackerPath: sandbox.trackerPath, env });
  hubs.push(hub);
  await body(hub.url, hub, sandbox);
}

const revisionOf = async (url) => (await call(url, '/api/dependency-audit')).body.revision;
const post = async (url, path, payload) => call(url, path, mutation(url, { trackerRevision: await revisionOf(url), ...payload }));

await runSuite('agent-api', async () => {
  // ---- health -------------------------------------------------------------------------
  await withHub([taskRow({ TaskID: 'A-001', Status: 'Ready' })], { TASK_HUB_SERIAL_LANE: 'true' }, async (url, hub, sandbox) => {
    const health = await call(url, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.tool, 'task-hub');
    assert.match(health.body.toolVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof health.body.projectId, 'string');
    assert.equal(typeof health.body.projectName, 'string');
    assert.equal(health.body.trackerRevision, await revisionOf(url));
    assert.equal(health.body.serialLane, true);
    assert.ok(!Number.isNaN(Date.parse(health.body.startedAt)));
    assert.equal(health.body.pid, hub.child.pid);
    assert.match(health.body.instanceId, /^[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(health.body).includes(sandbox.dir), 'health must not expose the tracker location');
    assert.equal(health.headers.get('cache-control'), 'no-store');

    // The revision in health is the one writes need.
    const created = await post(url, '/api/tasks', {
      agent: 'planner', reason: 'health revision is usable',
      newTask: { taskId: 'A-002', taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'T', task: 'x', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent', priority: 'P1', acceptance: 'a', completionAuthority: 'IndependentReviewerAgent' },
    });
    assert.equal(created.status, 201);
    assert.notEqual((await call(url, '/api/health')).body.trackerRevision, health.body.trackerRevision, 'revision changes after a write');
  });

  // A broken tracker keeps the server answering and says why.
  await withHub([taskRow({ TaskID: 'A-001' }), taskRow({ TaskID: 'A-001' })], {}, async (url) => {
    const health = await call(url, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, false);
    assert.match(health.body.trackerError, /duplicate TaskID/);
    assert.equal((await call(url, '/api/tasks')).status, 422);
  });
  {
    const sandbox = await createSandbox('task-tracker-agentapi-missing-', []);
    sandboxes.push(sandbox);
    const hub = await startHub({ trackerPath: join(sandbox.dir, 'does-not-exist.csv') });
    hubs.push(hub);
    const health = await call(hub.url, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, false);
    assert.equal(health.body.trackerRevision, null);
    assert.match(health.body.trackerError, /does not exist yet.*init-instance/);
    const list = await call(hub.url, '/api/tasks');
    assert.equal(list.status, 503);
    assert.equal(list.body.code, 'tracker-missing');
  }

  // ---- task list + filters ----------------------------------------------------------------
  const rows = [
    taskRow({ TaskID: 'S-FISH', TaskType: 'Story', Milestone: 'M1', Task: '钓鱼玩法', Status: 'Backlog', CompletionAuthority: 'NotApplicable', Priority: 'P1' }),
    taskRow({ TaskID: 'T-001', ParentID: 'S-FISH', Task: '抛竿与收线', Status: 'Done', Priority: 'P1', Evidence: 'LONG EVIDENCE '.repeat(50) }),
    taskRow({ TaskID: 'T-002', ParentID: 'S-FISH', DependsOn: 'T-001', Status: 'Ready', Priority: 'P1', Task: 'Second' }),
    taskRow({ TaskID: 'B-001', TaskType: 'Bug', ParentID: 'S-FISH', Status: 'Backlog', Priority: 'P0', Milestone: 'M2', Task: 'Bug one' }),
    taskRow({ TaskID: 'D-001', Status: 'Awaiting Owner', CompletionAuthority: 'DecisionOwner', Milestone: 'M2', Blocker: 'Owner product decision needed.', Task: 'Decide' }),
  ];
  await withHub(rows, {}, async (url) => {
    const all = await call(url, '/api/tasks');
    assert.equal(all.status, 200);
    assert.equal(all.body.trackerRevision, await revisionOf(url));
    assert.deepEqual([all.body.total, all.body.count, all.body.truncated], [5, 5, false]);
    assert.deepEqual(all.body.tasks.map((task) => task.taskId), ['S-FISH', 'T-001', 'T-002', 'B-001', 'D-001']);
    assert.deepEqual(Object.keys(all.body.tasks[1]).sort(), ['activeRun', 'blocker', 'completionAuthority', 'dependsOn', 'milestone', 'parentId', 'priority', 'status', 'taskId', 'taskType', 'title']);
    assert.equal(all.body.tasks[1].title, '抛竿与收线');
    assert.equal(all.body.tasks[2].dependsOn, 'T-001');
    assert.ok(!all.text.includes('LONG EVIDENCE'), 'the compact list must not carry the Evidence log');
    assert.equal(all.body.tasks[0].status, 'Backlog', 'a Story shows its derived status');

    const ids = async (query) => (await call(url, `/api/tasks${query}`)).body.tasks.map((task) => task.taskId);
    assert.deepEqual(await ids('?status=Ready'), ['T-002']);
    assert.deepEqual(await ids('?status=ready'), ['T-002']);
    assert.deepEqual(await ids('?status=Ready,Done'), ['T-001', 'T-002']);
    assert.deepEqual(await ids('?status=Awaiting%20Owner'), ['D-001']);
    assert.deepEqual(await ids('?milestone=m2'), ['B-001', 'D-001']);
    assert.deepEqual(await ids('?type=story'), ['S-FISH']);
    assert.deepEqual(await ids('?type=Bug'), ['B-001']);
    assert.deepEqual(await ids('?parent=S-FISH'), ['T-001', 'T-002', 'B-001']);
    assert.deepEqual(await ids('?parent=S-FISH&status=Done'), ['T-001']);
    assert.deepEqual(await ids('?status=Nonexistent'), []);
    const limited = await call(url, '/api/tasks?limit=2');
    assert.deepEqual([limited.body.total, limited.body.count, limited.body.truncated], [5, 2, true]);

    for (const bad of ['?stauts=Ready', '?type=Epic', '?limit=0', '?limit=abc', '?limit=5000']) {
      const result = await call(url, `/api/tasks${bad}`);
      assert.equal(result.status, 400, bad);
      assert.equal(result.body.code, 'bad-query');
    }
    assert.match((await call(url, '/api/tasks?stauts=Ready')).body.error, /Unknown query parameter 'stauts'\. Supported: status, milestone, type, parent, limit\./);

    // activeRun appears for a claimed task.
    const started = await post(url, '/api/runs/start', { taskId: 'T-002', agent: 'impl', verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const running = (await call(url, '/api/tasks?status=In%20Progress')).body.tasks;
    assert.equal(running.length, 1);
    assert.equal(running[0].activeRun, started.body.run.runId);
    assert.equal((await call(url, '/api/tasks?status=Done')).body.tasks[0].activeRun, null);
  });

  // ---- next: choice and reasons ----------------------------------------------------------------
  // Priority first, then file order; acceptance and spec travel with the answer.
  await withHub([
    taskRow({ TaskID: 'N-001', Status: 'Ready', Priority: 'P1', Acceptance: 'first acceptance', SpecRef: 'docs/a.md#n-001' }),
    taskRow({ TaskID: 'N-002', Status: 'Ready', Priority: 'P0', Acceptance: 'urgent acceptance', SpecRef: 'docs/a.md#n-002' }),
    taskRow({ TaskID: 'N-003', Status: 'Ready', Priority: 'P0' }),
  ], {}, async (url) => {
    const next = await call(url, '/api/next');
    assert.equal(next.status, 200);
    assert.equal(next.body.next.taskId, 'N-002');
    assert.equal(next.body.next.acceptance, 'urgent acceptance');
    assert.equal(next.body.next.specRef, 'docs/a.md#n-002');
    assert.match(next.body.reason, /^Ready: claim it with "tt start N-002" \(2 more Ready: N-003, N-001\)\.$/);
    assert.equal(next.body.trackerRevision, await revisionOf(url));
  });

  // Serial lane walk-through: In Progress -> In Review -> Done -> successor Ready.
  await withHub([
    taskRow({ TaskID: 'W-001', Status: 'Ready' }),
    taskRow({ TaskID: 'W-002', Status: 'Backlog', DependsOn: 'W-001' }),
    taskRow({ TaskID: 'W-003', Status: 'Backlog', DependsOn: 'W-002' }),
  ], { TASK_HUB_SERIAL_LANE: 'true' }, async (url) => {
    assert.equal((await call(url, '/api/next')).body.next.taskId, 'W-001');
    const started = await post(url, '/api/runs/start', { taskId: 'W-001', agent: 'impl', verificationProfile: 'logic', scope: 's', expectedBehavior: 'e' });
    let next = (await call(url, '/api/next')).body;
    assert.equal(next.next, null);
    assert.match(next.reason, new RegExp(`W-001 is In Progress \\(Run ${started.body.run.runId}, agent impl\\): finish it with: tt done W-001`));
    assert.match(next.reason, /Waiting on a predecessor: W-002/);
    assert.deepEqual(next.blockedBy, [{ taskId: 'W-001', status: 'In Progress' }]);
    await post(url, `/api/tasks/W-001/runs/${started.body.run.runId}/close`, { outcome: 'verified', summary: 'done' });
    next = (await call(url, '/api/next')).body;
    assert.match(next.reason, /W-001 is In Review \(implemented by impl\): a different reviewer decides with: tt review W-001 approve\|reject\|block "notes"/);
    await post(url, '/api/tasks/W-001/review', { action: 'claim', reviewer: 'rev' });
    await post(url, '/api/tasks/W-001/review', { action: 'decision', reviewer: 'rev', decision: 'approved', notes: 'ok' });
    next = (await call(url, '/api/next')).body;
    assert.equal(next.next.taskId, 'W-002', 'approval advances the serial lane to the successor');
  });

  // Owner waits, actionable blockers, runnable backlog, dependency-blocked backlog, done, empty.
  await withHub([taskRow({ TaskID: 'O-001', Status: 'Awaiting Owner', CompletionAuthority: 'DecisionOwner' }), taskRow({ TaskID: 'O-002', Status: 'Backlog', DependsOn: 'O-001' })], {}, async (url) => {
    const next = (await call(url, '/api/next')).body;
    assert.equal(next.next, null);
    assert.match(next.reason, /^Waiting for the owner: O-001 \(Awaiting Owner\)\./);
  });
  await withHub([taskRow({ TaskID: 'K-001', Status: 'Blocked', Blocker: 'Godot binary missing' })], {}, async (url) => {
    assert.match((await call(url, '/api/next')).body.reason, /^Blocked: K-001 - Godot binary missing\./);
  });
  await withHub([taskRow({ TaskID: 'G-001', Status: 'Done' }), taskRow({ TaskID: 'G-002', Status: 'Backlog', DependsOn: 'G-001', Priority: 'P2' }), taskRow({ TaskID: 'G-003', Status: 'Backlog', DependsOn: 'G-001', Priority: 'P0' })], {}, async (url) => {
    const next = (await call(url, '/api/next')).body;
    assert.match(next.reason, /^Nothing is admitted\. The next runnable Backlog task is G-003: "tt start G-003" admits and starts it\.$/);
    assert.deepEqual(next.runnableBacklog, ['G-003', 'G-002'], 'every runnable Backlog task, best first');
  });
  await withHub([taskRow({ TaskID: 'J-001', Status: 'Done' }), taskRow({ TaskID: 'J-002', Status: 'Backlog', DependsOn: 'J-001' }), taskRow({ TaskID: 'J-003', Status: 'Backlog', DependsOn: 'J-002' })], {}, async (url) => {
    assert.deepEqual((await call(url, '/api/next')).body.runnableBacklog, ['J-002'], 'only the task whose dependencies are Done');
  });
  await withHub([taskRow({ TaskID: 'J-004', Status: 'In Progress', Implementer: 'someone' }), taskRow({ TaskID: 'J-005', Status: 'Backlog' })], {}, async (url) => {
    assert.equal((await call(url, '/api/next')).body.runnableBacklog, undefined, 'nothing is listed while another task holds the lane');
  });
  await withHub([taskRow({ TaskID: 'H-001', Status: 'Done' }), taskRow({ TaskID: 'H-002', Status: 'Backlog', DependsOn: 'H-003' }), taskRow({ TaskID: 'H-003', Status: 'Deferred' })], {}, async (url) => {
    const waiting = (await call(url, '/api/next')).body;
    assert.match(waiting.reason, /^Backlog tasks wait for unfinished dependencies: H-002 needs H-003.$/);
    assert.equal(waiting.runnableBacklog, undefined);
  });
  await withHub([taskRow({ TaskID: 'F-001', Status: 'Done' }), taskRow({ TaskID: 'F-002', Status: 'Done' })], {}, async (url) => {
    assert.equal((await call(url, '/api/next')).body.reason, 'All 2 executable task(s) are Done.');
  });
  await withHub([], {}, async (url) => {
    const next = (await call(url, '/api/next')).body;
    assert.equal(next.next, null);
    assert.match(next.reason, /No executable tasks exist yet/);
  });

  console.log('agent-api test passed: /api/health, /api/tasks filters and compact shape, /api/next choice and lane reasons.');
}, async () => {
  for (const hub of hubs) await hub.stop();
  for (const sandbox of sandboxes) await sandbox.dispose();
});
