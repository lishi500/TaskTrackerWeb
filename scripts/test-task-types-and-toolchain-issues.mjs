#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-types-issues-'));
const trackerPath = join(sandbox, 'task_tracker.csv');
const legacyHeader = ['TaskID', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'ReviewRequired', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];
const legacyRows = [
  ['TYPE-001', '', 'M1', 'Test', 'Existing executable task', 'README.md', '', 'Agent', 'Ready', 'P0', 'Supports type schema migration.', 'Yes', '', '', '', '', '', ''],
  ['TYPE-002', 'TYPE-001', 'M1', 'Test', 'Second executable task', 'README.md', '', 'Agent', 'Backlog', 'P1', 'Supports cross-task issue reporting.', 'Yes', '', '', '', '', '', ''],
  ['TYPE-003', '', 'M1', 'Test', 'Existing decision-owner task', 'README.md', '', 'Human decision owner', 'Backlog', 'P1', 'Supports completion-authority migration.', 'No', '', '', '', '', '', ''],
];
await writeFile(trackerPath, `${legacyHeader.join(',')}\n${legacyRows.map((row) => row.join(',')).join('\n')}\n`, 'utf8');

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'test', TASK_HUB_SERIAL_LANE: 'false', PORT: '0', HOST: '127.0.0.1', TRACKER_CSV: trackerPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const url = await new Promise((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for task-type test server.')), 10_000);
  lines.on('line', (line) => {
    const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
    if (match) { clearTimeout(timeout); resolveUrl(match[1]); }
  });
  child.once('exit', (code) => reject(new Error(`Test server exited early with ${code}.`)));
});

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, options);
  return { response, body: await response.json() };
}

const mutation = (payload, origin = url) => ({
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

async function createTask(trackerRevision, newTask) {
  return request('/api/tasks', mutation({
    trackerRevision,
    agent: 'task-type-test-agent',
    reason: 'Exercise the generic typed work-item creation contract.',
    newTask,
  }));
}

try {
  const legacyTracker = await request('/api/tracker');
  assert.equal(legacyTracker.response.status, 200);
  assert.equal(legacyTracker.body.records[0].TaskType, 'Task');

  const legacyCreate = await createTask(legacyTracker.body.revision, {
    taskId: 'TYPE-PRE-MIGRATION', taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'Test',
    task: 'Must not create before schema migration', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'The legacy schema remains explicit.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(legacyCreate.response.status, 422);

  const migrated = await request('/api/tracker/task-types/migrate', mutation({
    trackerRevision: legacyTracker.body.revision, actor: 'schema-owner', reason: 'Add explicit TaskType without inferring legacy hierarchy.',
  }));
  assert.equal(migrated.response.status, 200);
  assert.equal(migrated.body.records.every((record) => record.TaskType === 'Task'), true);
  assert.equal(migrated.body.records.find(({ TaskID }) => TaskID === 'TYPE-002').ParentID, '');
  assert.match(migrated.body.records.find(({ TaskID }) => TaskID === 'TYPE-002').Evidence, /LEGACY PARENTID RETAINED AS HISTORY: TYPE-001/);
  assert.match(await readFile(trackerPath, 'utf8'), /^TaskID,TaskType,ParentID,/);

  const duplicateMigration = await request('/api/tracker/task-types/migrate', mutation({
    trackerRevision: migrated.body.trackerRevision, actor: 'schema-owner', reason: 'A second migration must not overwrite history.',
  }));
  assert.equal(duplicateMigration.response.status, 409);

  const missingAuthority = await createTask(migrated.body.trackerRevision, {
    taskId: 'TYPE-PRE-AUTHORITY-MIGRATION', taskType: 'Task', parentId: '', milestone: 'M1', workstream: 'Test',
    task: 'Must not create before completion-authority migration', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'The canonical authority schema remains explicit.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(missingAuthority.response.status, 422);

  const authorityMigration = await request('/api/tracker/completion-authority/migrate', mutation({
    trackerRevision: migrated.body.trackerRevision, actor: 'schema-owner', reason: 'Replace the ambiguous legacy review flag with explicit completion authority.',
  }));
  assert.equal(authorityMigration.response.status, 200);
  assert.equal(authorityMigration.body.records.find(({ TaskID }) => TaskID === 'TYPE-001').CompletionAuthority, 'IndependentReviewerAgent');
  assert.equal(authorityMigration.body.records.find(({ TaskID }) => TaskID === 'TYPE-003').CompletionAuthority, 'DecisionOwner');
  assert.match(await readFile(trackerPath, 'utf8'), /^TaskID,TaskType,ParentID,[\s\S]*CompletionAuthority,/);
  const duplicateAuthorityMigration = await request('/api/tracker/completion-authority/migrate', mutation({
    trackerRevision: authorityMigration.body.trackerRevision, actor: 'schema-owner', reason: 'A second authority migration must not rewrite the schema.',
  }));
  assert.equal(duplicateAuthorityMigration.response.status, 409);

  const story = await createTask(authorityMigration.body.trackerRevision, {
    taskId: 'STORY-001', taskType: 'Story', parentId: '', milestone: 'M2', workstream: 'Test',
    task: 'Future feature scope', specRef: 'README.md', dependsOn: '', ownerRole: 'Product',
    priority: 'P1', acceptance: 'Child work is planned only when execution is near.', completionAuthority: 'NotApplicable',
  });
  assert.equal(story.response.status, 201);
  assert.equal(story.body.task.TaskType, 'Story');

  const invalidStory = await createTask(story.body.trackerRevision, {
    taskId: 'STORY-BAD', taskType: 'Story', parentId: 'STORY-001', milestone: 'M2', workstream: 'Test',
    task: 'Invalid nested scope', specRef: 'README.md', dependsOn: '', ownerRole: 'Product',
    priority: 'P1', acceptance: 'Must be rejected.', completionAuthority: 'NotApplicable',
  });
  assert.equal(invalidStory.response.status, 422);

  const invalidStoryAuthority = await createTask(story.body.trackerRevision, {
    taskId: 'STORY-BAD-AUTHORITY', taskType: 'Story', parentId: '', milestone: 'M2', workstream: 'Test',
    task: 'Invalid Story authority', specRef: 'README.md', dependsOn: '', ownerRole: 'Product',
    priority: 'P1', acceptance: 'Must be rejected.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(invalidStoryAuthority.response.status, 422);

  const invalidParent = await createTask(story.body.trackerRevision, {
    taskId: 'TYPE-BAD-PARENT', taskType: 'Task', parentId: 'TYPE-001', milestone: 'M2', workstream: 'Test',
    task: 'Invalid non-Story parent', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'Must be rejected.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(invalidParent.response.status, 422);

  const invalidExecutableAuthority = await createTask(story.body.trackerRevision, {
    taskId: 'TYPE-BAD-AUTHORITY', taskType: 'Task', parentId: '', milestone: 'M2', workstream: 'Test',
    task: 'Invalid executable authority', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'Must be rejected.', completionAuthority: 'NotApplicable',
  });
  assert.equal(invalidExecutableAuthority.response.status, 422);

  const childTask = await createTask(story.body.trackerRevision, {
    taskId: 'TYPE-CHILD-001', taskType: 'Task', parentId: 'STORY-001', milestone: 'M2', workstream: 'Test',
    task: 'Implement a scoped slice', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P0', acceptance: 'Can be admitted as an ordinary executable Task.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(childTask.response.status, 201);

  const childBug = await createTask(childTask.body.trackerRevision, {
    taskId: 'BUG-CHILD-001', taskType: 'Bug', parentId: 'STORY-001', milestone: 'M2', workstream: 'Test',
    task: 'Fix scoped regression', specRef: 'README.md', dependsOn: '', ownerRole: 'Agent',
    priority: 'P0', acceptance: 'Uses the ordinary Bug workflow.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(childBug.response.status, 201);
  assert.equal(childBug.body.task.TaskType, 'Bug');

  const storyDependency = await createTask(childBug.body.trackerRevision, {
    taskId: 'TYPE-BAD-DEPENDENCY', taskType: 'Task', parentId: '', milestone: 'M2', workstream: 'Test',
    task: 'Invalid Story dependency', specRef: 'README.md', dependsOn: 'STORY-001', ownerRole: 'Agent',
    priority: 'P1', acceptance: 'Must be rejected.', completionAuthority: 'IndependentReviewerAgent',
  });
  assert.equal(storyDependency.response.status, 422);

  const storyPacket = await request('/api/tasks/STORY-001/packet');
  assert.equal(storyPacket.body.packet.context.story, null);
  assert.deepEqual(storyPacket.body.packet.context.children.map(({ taskId }) => taskId), ['TYPE-CHILD-001', 'BUG-CHILD-001']);
  const childPacket = await request('/api/tasks/TYPE-CHILD-001/packet');
  assert.equal(childPacket.body.packet.context.story.taskId, 'STORY-001');
  assert.equal(childPacket.body.packet.context.story.goal, 'Future feature scope');
  assert.equal(childPacket.body.packet.context.story.acceptance, 'Child work is planned only when execution is near.');
  assert.deepEqual(childPacket.body.packet.dependencies, []); // Parent is context, never an execution dependency.
  assert.equal((await request('/api/tasks/TYPE-001/packet')).body.packet.context.story, null);
  const storyAdmission = await request('/api/tasks/STORY-001/admit', mutation({
    trackerRevision: storyPacket.body.trackerRevision, agent: 'task-type-test-agent', targetStatus: 'Ready',
    reason: 'A Story must never become execution work.',
  }));
  assert.equal(storyAdmission.response.status, 409);
  const storyRun = await request('/api/runs/start', mutation({
    taskId: 'STORY-001', trackerRevision: storyPacket.body.trackerRevision, agent: 'task-type-test-agent',
    verificationProfile: 'logic', scope: 'Must not create a Story Run.', expectedBehavior: 'Story is a scope container.',
  }));
  assert.equal(storyRun.response.status, 409);

  const csvBeforeIssues = await readFile(trackerPath, 'utf8');

  const reportOne = await request('/api/toolchain-issues', mutation({
    taskId: 'TYPE-001', reporter: 'unity-agent', failureKey: 'unity.cli.editor-play-timeout', toolchain: 'unity-cli',
    operation: 'editor_play', summary: 'Unity command timed out before play-mode evidence was available.', evidenceRef: 'logs/editor.log',
  }));
  assert.equal(reportOne.response.status, 201);
  assert.equal(reportOne.body.issue.unacknowledgedCount, 1);

  const reportTwo = await request('/api/toolchain-issues', mutation({
    taskId: 'TYPE-CHILD-001', reporter: 'unity-agent', failureKey: 'unity.cli.editor-play-timeout', toolchain: 'unity-cli',
    operation: 'editor_play', summary: 'Unity command timed out before play-mode evidence was available.',
  }));
  assert.equal(reportTwo.response.status, 201);
  assert.equal(reportTwo.body.issue.unacknowledgedCount, 2);

  const beforeAck = await request('/api/toolchain-issues');
  assert.equal(beforeAck.response.status, 200);
  assert.equal(beforeAck.body.activeIssueCount, 1);
  assert.equal(beforeAck.body.issues[0].totalReportCount, 2);

  const eventsBeforeStaleAck = await readFile(join(sandbox, 'toolchain_issue_events.jsonl'), 'utf8');
  const missingCountAck = await request('/api/toolchain-issues/unity.cli.editor-play-timeout/ack', mutation({
    acknowledger: 'owner', notes: 'An ACK must describe the reports actually inspected.',
  }));
  assert.equal(missingCountAck.response.status, 400);
  const staleAck = await request('/api/toolchain-issues/unity.cli.editor-play-timeout/ack', mutation({
    acknowledger: 'owner', notes: 'This page saw one report before a second one arrived.', expectedReportCount: 1,
  }));
  assert.equal(staleAck.response.status, 409);
  assert.equal(await readFile(join(sandbox, 'toolchain_issue_events.jsonl'), 'utf8'), eventsBeforeStaleAck);
  assert.equal((await request('/api/toolchain-issues')).body.issues[0].unacknowledgedCount, 2);

  const acknowledged = await request('/api/toolchain-issues/unity.cli.editor-play-timeout/ack', mutation({
    acknowledger: 'owner', notes: 'Investigate the Unity command runner before scheduling more play-mode verification.', expectedReportCount: 2,
  }));
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.body.issue.unacknowledgedCount, 0);
  assert.equal(acknowledged.body.issue.acknowledgedReportCount, 2);
  assert.equal((await request('/api/toolchain-issues')).body.issues.length, 0);

  const recurrence = await request('/api/toolchain-issues', mutation({
    taskId: 'BUG-CHILD-001', reporter: 'unity-agent', failureKey: 'unity.cli.editor-play-timeout', toolchain: 'unity-cli',
    operation: 'editor_play', summary: 'Unity command timed out again after the prior investigation.',
  }));
  assert.equal(recurrence.response.status, 201);
  assert.equal(recurrence.body.issue.unacknowledgedCount, 1);
  assert.equal(recurrence.body.issue.acknowledgedReportCount, 2);

  const history = await request('/api/toolchain-issues?includeAcknowledged=true');
  assert.equal(history.response.status, 200);
  assert.equal(history.body.issues[0].totalReportCount, 3);
  assert.equal(history.body.issues[0].unacknowledgedCount, 1);
  assert.equal(history.body.issues[0].acknowledgedReportCount, 2);

  const recurrenceAck = await request('/api/toolchain-issues/unity.cli.editor-play-timeout/ack', mutation({
    acknowledger: 'owner', notes: 'The recurring failure is acknowledged and routed for a new diagnostic pass.', expectedReportCount: 3,
  }));
  assert.equal(recurrenceAck.response.status, 200);
  assert.equal(recurrenceAck.body.issue.unacknowledgedCount, 0);
  assert.equal(recurrenceAck.body.issue.acknowledgedReportCount, 3);
  const duplicateAck = await request('/api/toolchain-issues/unity.cli.editor-play-timeout/ack', mutation({
    acknowledger: 'owner', notes: 'There is no newer report to acknowledge.', expectedReportCount: 3,
  }));
  assert.equal(duplicateAck.response.status, 409);

  const badOrigin = await request('/api/toolchain-issues', mutation({
    taskId: 'TYPE-001', reporter: 'unity-agent', failureKey: 'unity.cli.bad-origin', toolchain: 'unity-cli',
    operation: 'editor_play', summary: 'Must be rejected before it becomes an event.',
  }, 'http://example.test'));
  assert.equal(badOrigin.response.status, 403);

  const unknownAck = await request('/api/toolchain-issues/unity.cli.unknown/ack', mutation({ acknowledger: 'owner', notes: 'No matching alert.', expectedReportCount: 1 }));
  assert.equal(unknownAck.response.status, 404);
  assert.equal(await readFile(trackerPath, 'utf8'), csvBeforeIssues, 'Reports and ACKs must not change task state or its revision.');

  console.log('task-type and toolchain-issue test passed: migration, Story context/boundaries, typed children, cross-task aggregation, stale ACK rejection, history and recurrence count.');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
  await rm(sandbox, { recursive: true, force: true });
}
