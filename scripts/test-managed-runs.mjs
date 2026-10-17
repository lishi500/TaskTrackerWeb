#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url);
const sandbox = await mkdtemp(join(tmpdir(), 'task-tracker-runs-'));
const trackerPath = join(sandbox, 'task_tracker.csv');
const recordsPath = join(sandbox, 'task-records');
const header = ['TaskID', 'TaskType', 'ParentID', 'Milestone', 'Workstream', 'Task', 'SpecRef', 'DependsOn', 'OwnerRole', 'Status', 'Priority', 'Acceptance', 'CompletionAuthority', 'Blocker', 'Implementer', 'Evidence', 'Updated', 'ReviewClaim', 'Reviewer'];
const recoveryRow = ['TEST-001', 'Task', '', 'M0', 'Test', 'Managed run recovery lifecycle', 'README.md', '', 'Agent', 'Ready', 'P0', 'Claims and closes safely', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const nonReadyRow = ['TEST-002', 'Task', '', 'M0', 'Test', 'Non-Ready claim rejection', 'README.md', '', 'Agent', 'In Progress', 'P0', 'Rejects a second claim', 'IndependentReviewerAgent', '', 'other-agent', 'EXISTING CLAIM', '', '', ''];
const normalRow = ['TEST-003', 'Task', '', 'M0', 'Test', 'Managed run normal lifecycle', 'README.md', '', 'Agent', 'Ready', 'P0', 'Closes safely', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const claimRecoveryRow = ['TEST-004', 'Task', '', 'M0', 'Test', 'Managed claim recovery lifecycle', 'README.md', '', 'Agent', 'Ready', 'P0', 'Does not reuse a failed claim Run ID', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const committedClaimRecoveryRow = ['TEST-005', 'Task', '', 'M0', 'Test', 'Committed claim intent cleanup lifecycle', 'README.md', '', 'Agent', 'Ready', 'P0', 'Does not block a later Ready retry after a reviewed Run', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const preclaimBlockRow = ['TEST-006', 'Task', '', 'M0', 'Test', 'Pre-claim blocker lifecycle', 'README.md', '', 'Agent', 'Ready', 'P0', 'Blocks an incomplete packet without a Run', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const dependencyUnblockRow = ['TEST-007', 'Task', '', 'M0', 'Test', 'Dependency unblock lifecycle', 'README.md', 'TEST-001', 'Agent', 'Blocked', 'P0', 'Becomes Ready only after all dependencies are Done', 'IndependentReviewerAgent', 'TEST-001 review incomplete', '', '', '', '', ''];
const zeroDependencyBlockedRow = ['TEST-008', 'Task', '', 'M0', 'Test', 'Zero dependency unblock rejection', 'README.md', '', 'Agent', 'Blocked', 'P0', 'Must not be dependency-unblocked', 'IndependentReviewerAgent', 'Manual blocker', '', '', '', '', ''];
const unfinishedDependencyBlockedRow = ['TEST-009', 'Task', '', 'M0', 'Test', 'Unfinished dependency unblock rejection', 'README.md', 'TEST-002', 'Agent', 'Blocked', 'P0', 'Must retain blocker while dependency remains unfinished', 'IndependentReviewerAgent', 'TEST-002 incomplete', '', '', '', '', ''];
const ownerWaitRow = ['TEST-010', 'Task', '', 'M0', 'Test', 'Decision-owner wait lifecycle', 'README.md', '', 'Human decision owner', 'Ready', 'P0', 'Moves only to an explicit owner status', 'DecisionOwner', '', '', '', '', '', ''];
const closedBlockRecoveryRow = ['TEST-011', 'Task', '', 'M0', 'Test', 'Closed blocked Run recovery lifecycle', 'README.md', 'TEST-001', 'Agent', 'Ready', 'P0', 'A closed blocked Run can be dependency-unblocked after its blocker is resolved', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const authorityRunRow = ['TEST-012', 'Task', '', 'M0', 'Test', 'Active authority Run lifecycle', 'README.md', '', 'Implementation agent', 'Ready', 'P0', 'An active Run can expose a direct DecisionOwner dependency', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const dependentOwnerRow = ['TEST-013', 'Task', '', 'M0', 'Test', 'Decision-owner preparation', 'README.md', 'TEST-012', 'Human decision owner', 'Backlog', 'P0', 'Enters an explicit owner wait only through its active direct authority Run', 'DecisionOwner', '', '', '', '', '', ''];
const dependencyRevisionRow = ['TEST-014', 'Task', '', 'M0', 'Test', 'Dependency revision lifecycle', 'README.md', 'TEST-001', 'Agent', 'Backlog', 'P0', 'Changes dependencies only through an auditable valid graph mutation', 'IndependentReviewerAgent', '', '', '', '', '', ''];
const decisionReviewRow = ['TEST-015', 'Task', '', 'M0', 'Test', 'Decision-owner review rejection', 'README.md', '', 'Human decision owner', 'In Review', 'P0', 'Cannot enter independent review', 'DecisionOwner', '', 'previous-agent', '', '', '', ''];
await mkdir(recordsPath, { recursive: true });
await writeFile(trackerPath, `${header.join(',')}\n${recoveryRow.join(',')}\n${nonReadyRow.join(',')}\n${normalRow.join(',')}\n${claimRecoveryRow.join(',')}\n${committedClaimRecoveryRow.join(',')}\n${preclaimBlockRow.join(',')}\n${dependencyUnblockRow.join(',')}\n${zeroDependencyBlockedRow.join(',')}\n${unfinishedDependencyBlockedRow.join(',')}\n${ownerWaitRow.join(',')}\n${closedBlockRecoveryRow.join(',')}\n${authorityRunRow.join(',')}\n${dependentOwnerRow.join(',')}\n${dependencyRevisionRow.join(',')}\n${decisionReviewRow.join(',')}\n`, 'utf8');

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    TASK_HUB_TEST_FAIL_CLOSE_AFTER_TRACKER: '1',
    TASK_HUB_TEST_FAIL_CLAIM_BEFORE_TRACKER: '1',
    TASK_HUB_TEST_FAIL_CLAIM_TASK: 'TEST-004',
    TASK_HUB_TEST_FAIL_CLAIM_AFTER_TRACKER: '1',
    TASK_HUB_TEST_FAIL_CLAIM_AFTER_TRACKER_TASK: 'TEST-005',
    TASK_HUB_SERIAL_LANE: 'false',
    PORT: '0',
    HOST: '127.0.0.1',
    TRACKER_CSV: trackerPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const lines = createInterface({ input: child.stdout });
const url = await new Promise((resolveUrl, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for test server.')), 10_000);
  lines.on('line', (line) => {
    const match = /Task tracker is available at (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
    if (match) {
      clearTimeout(timeout);
      resolveUrl(match[1]);
    }
  });
  child.once('exit', (code) => reject(new Error(`Test server exited early with ${code}.`)));
});

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, options);
  const body = await response.json();
  return { response, body };
}

try {
  const packet = await request('/api/tasks/TEST-001/packet');
  assert.equal(packet.response.status, 200);
  assert.equal(packet.body.task.Status, 'Ready');
  assert.ok(packet.body.trackerRevision);

  const mutation = (payload) => ({
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const wrongMime = await request('/api/runs/start', {
    method: 'POST',
    headers: { Origin: url },
    body: '{}',
  });
  assert.equal(wrongMime.response.status, 415);
  const crossOrigin = await request('/api/runs/start', {
    method: 'POST',
    headers: { Origin: 'http://localhost:9999', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(crossOrigin.response.status, 403);
  const decisionReviewPacket = await request('/api/tasks/TEST-015/packet');
  const decisionReview = await request('/api/tasks/TEST-015/review', mutation({
    trackerRevision: decisionReviewPacket.body.trackerRevision, action: 'claim', reviewer: 'independent-reviewer',
  }));
  assert.equal(decisionReview.response.status, 409);

  const contractPacket = await request('/api/tasks/TEST-006/packet');
  const missingContractField = await request('/api/tasks/TEST-006/contract', mutation({
    trackerRevision: contractPacket.body.trackerRevision,
    agent: 'contract-agent',
    reason: 'This must reject without the complete replacement contract.',
    task: 'Pre-claim blocker lifecycle',
    specRef: 'README.md',
  }));
  assert.equal(missingContractField.response.status, 400);
  const revisedContract = await request('/api/tasks/TEST-006/contract', mutation({
    trackerRevision: contractPacket.body.trackerRevision,
    agent: 'contract-agent',
    reason: 'The prior acceptance described an obsolete boundary; this replacement is explicitly auditable.',
    task: 'Pre-claim blocker lifecycle',
    specRef: 'README.md',
    acceptance: 'Records an incomplete packet without changing task status.',
  }));
  assert.equal(revisedContract.response.status, 200);
  assert.equal(revisedContract.body.task.Acceptance, 'Records an incomplete packet without changing task status.');
  assert.match(revisedContract.body.task.Evidence, /CONTRACT UPDATED: contract-agent/);
  const unchangedContract = await request('/api/tasks/TEST-006/contract', mutation({
    trackerRevision: revisedContract.body.trackerRevision,
    agent: 'contract-agent',
    reason: 'This must reject because no contract field changes.',
    task: 'Pre-claim blocker lifecycle',
    specRef: 'README.md',
    acceptance: 'Records an incomplete packet without changing task status.',
  }));
  assert.equal(unchangedContract.response.status, 409);

  const nonReadyPacket = await request('/api/tasks/TEST-002/packet');
  const nonReady = await request('/api/runs/start', mutation({
    taskId: 'TEST-002',
    trackerRevision: nonReadyPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Non-Ready claims must reject.',
    expectedBehavior: 'A resume flag cannot bypass the Ready-only claim rule.',
    resume: true,
  }));
  assert.equal(nonReady.response.status, 409);

  const startPacket = await request('/api/tasks/TEST-001/packet');
  const start = await request('/api/runs/start', mutation({
    taskId: 'TEST-001',
    trackerRevision: startPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Managed-run endpoint test only',
    expectedBehavior: 'Claim exactly one Ready task and preserve CSV authority.',
  }));
  assert.equal(start.response.status, 201);
  assert.equal(start.body.task.Status, 'In Progress');
  const { runId } = start.body.run;
  const revision = start.body.trackerRevision;

  const event = await request(`/api/tasks/TEST-001/runs/${runId}/events`, mutation({
    trackerRevision: revision,
    type: 'verify',
    result: 'pass',
    message: 'Focused lifecycle event was recorded.',
  }));
  assert.equal(event.response.status, 201);

  const artifact = await request(`/api/tasks/TEST-001/runs/${runId}/artifacts`, mutation({
    trackerRevision: revision,
    name: 'evidence',
    content: 'Managed-run test evidence.',
  }));
  assert.equal(artifact.response.status, 201);
  const nestedArtifact = await request(`/api/tasks/TEST-001/runs/${runId}/artifacts`, mutation({
    trackerRevision: revision,
    name: 'logs/editor.log',
    content: 'Nested immutable artifact path is retained.',
  }));
  assert.equal(nestedArtifact.response.status, 201);
  const nestedArtifactRead = await fetch(`${url}/api/tasks/TEST-001/runs/${runId}/artifacts/logs/editor.log`);
  assert.equal(nestedArtifactRead.status, 200);
  assert.equal(await nestedArtifactRead.text(), 'Nested immutable artifact path is retained.');
  const duplicateArtifact = await request(`/api/tasks/TEST-001/runs/${runId}/artifacts`, mutation({
    trackerRevision: revision,
    name: 'evidence',
    content: 'This must not overwrite the first artifact.',
  }));
  assert.equal(duplicateArtifact.response.status, 409);

  const stale = await request(`/api/tasks/TEST-001/runs/${runId}/close`, mutation({
    trackerRevision: packet.body.trackerRevision,
    outcome: 'verified',
    summary: 'This must reject as stale.',
  }));
  assert.equal(stale.response.status, 409);

  const close = await request(`/api/tasks/TEST-001/runs/${runId}/close`, mutation({
    trackerRevision: revision,
    outcome: 'verified',
    summary: 'This first close exercises recovery after the atomic CSV replacement.',
  }));
  assert.equal(close.response.status, 500);
  const recoveryPacket = await request('/api/tasks/TEST-001/packet');
  assert.equal(recoveryPacket.body.task.Status, 'In Review');
  const selfReview = await request('/api/tasks/TEST-001/review', mutation({
    trackerRevision: recoveryPacket.body.trackerRevision,
    action: 'claim',
    reviewer: 'test-agent',
  }));
  assert.equal(selfReview.response.status, 409);
  // The self-review is rejected, but it must first reconcile the failed close.
  assert.match(await readFile(join(recordsPath, 'TEST-001', runId, 'run.json'), 'utf8'), /"status": "verified"/);
  const postCloseEvent = await request(`/api/tasks/TEST-001/runs/${runId}/events`, mutation({
    trackerRevision: recoveryPacket.body.trackerRevision,
    type: 'verify',
    result: 'pass',
    message: 'This must reject after review-triggered close recovery.',
  }));
  assert.equal(postCloseEvent.response.status, 409);
  assert.match(await readFile(trackerPath, 'utf8'), /TEST-001[^\n]*In Review/);
  assert.match(await readFile(join(recordsPath, 'TEST-001', runId, 'events.jsonl'), 'utf8'), /"type":"claim"/);
  const reviewClaim = await request('/api/tasks/TEST-001/review', mutation({
    trackerRevision: recoveryPacket.body.trackerRevision,
    action: 'claim',
    reviewer: 'independent-reviewer',
  }));
  assert.equal(reviewClaim.response.status, 200);
  const reviewDecision = await request('/api/tasks/TEST-001/review', mutation({
    trackerRevision: reviewClaim.body.trackerRevision,
    action: 'decision',
    reviewer: 'independent-reviewer',
    decision: 'approved',
    notes: 'Independent review confirms the recovered Run and CSV state are consistent.',
  }));
  assert.equal(reviewDecision.response.status, 200);
  assert.equal(reviewDecision.body.task.Status, 'Done');

  const createPacket = await request('/api/tasks/TEST-001/packet');
  const rejectedCreation = await request('/api/tasks', mutation({
    trackerRevision: createPacket.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'This fixture proves graph validation still protects a creation mutation.',
    newTask: {
      taskId: 'TEST-CREATE-BAD', taskType: 'Task', parentId: '', milestone: 'M0', workstream: 'Test',
      task: 'Invalid planned task', specRef: 'README.md', dependsOn: 'MISSING-001',
      ownerRole: 'Agent', priority: 'P0', acceptance: 'Must never enter the CSV.', completionAuthority: 'IndependentReviewerAgent',
    },
  }));
  assert.equal(rejectedCreation.response.status, 422);
  const created = await request('/api/tasks', mutation({
    trackerRevision: createPacket.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'A discovered repair must become an auditable planned task before it can be admitted.',
    newTask: {
      taskId: 'TEST-CREATE-001', taskType: 'Task', parentId: '', milestone: 'M0', workstream: 'Test',
      task: 'Create a planned remediation task', specRef: 'README.md', dependsOn: 'TEST-001',
      ownerRole: 'Agent', priority: 'P0', acceptance: 'Starts as Backlog and requires normal admission.', completionAuthority: 'IndependentReviewerAgent',
    },
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.task.Status, 'Backlog');
  assert.match(created.body.task.Evidence, /CREATED: scheduler-agent/);
  const duplicateCreation = await request('/api/tasks', mutation({
    trackerRevision: created.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'This must reject duplicate Task IDs.',
    newTask: {
      taskId: 'TEST-CREATE-001', taskType: 'Task', parentId: '', milestone: 'M0', workstream: 'Test',
      task: 'Duplicate planned task', specRef: 'README.md', dependsOn: '',
      ownerRole: 'Agent', priority: 'P0', acceptance: 'Must not replace the existing task.', completionAuthority: 'IndependentReviewerAgent',
    },
  }));
  assert.equal(duplicateCreation.response.status, 409);
  const createdPacket = await request('/api/tasks/TEST-CREATE-001/packet');
  const admittedCreated = await request('/api/tasks/TEST-CREATE-001/admit', mutation({
    trackerRevision: createdPacket.body.trackerRevision,
    agent: 'scheduler-agent', targetStatus: 'Ready',
    reason: 'The planned task has a completed dependency and is deliberately admitted to the execution lane.',
  }));
  assert.equal(admittedCreated.response.status, 200);
  assert.equal(admittedCreated.body.task.Status, 'Ready');

  const dependencyRevisionPacket = await request('/api/tasks/TEST-014/packet');
  const missingDependencies = await request('/api/tasks/TEST-014/dependencies', mutation({
    trackerRevision: dependencyRevisionPacket.body.trackerRevision,
    agent: 'dependency-agent',
    reason: 'A complete replacement must name dependsOn, even when it is empty.',
  }));
  assert.equal(missingDependencies.response.status, 400);
  const revisedDependencies = await request('/api/tasks/TEST-014/dependencies', mutation({
    trackerRevision: dependencyRevisionPacket.body.trackerRevision,
    agent: 'dependency-agent',
    reason: 'The planned task needs a newly discovered completed prerequisite before admission.',
    dependsOn: 'TEST-001;TEST-003',
  }));
  assert.equal(revisedDependencies.response.status, 200);
  assert.equal(revisedDependencies.body.task.DependsOn, 'TEST-001;TEST-003');
  assert.match(revisedDependencies.body.task.Evidence, /DEPENDENCIES UPDATED: dependency-agent/);
  const beforeInvalidDependencyRevision = await readFile(trackerPath, 'utf8');
  const invalidDependencyRevision = await request('/api/tasks/TEST-014/dependencies', mutation({
    trackerRevision: revisedDependencies.body.trackerRevision,
    agent: 'dependency-agent',
    reason: 'This must reject a self-dependency without modifying the CSV.',
    dependsOn: 'TEST-014',
  }));
  assert.equal(invalidDependencyRevision.response.status, 422);
  assert.match(invalidDependencyRevision.body.error, /self dependency/i);
  assert.equal(await readFile(trackerPath, 'utf8'), beforeInvalidDependencyRevision);
  const readyDependencyPacket = await request('/api/tasks/TEST-CREATE-001/packet');
  const readyDependencyRevision = await request('/api/tasks/TEST-CREATE-001/dependencies', mutation({
    trackerRevision: readyDependencyPacket.body.trackerRevision,
    agent: 'dependency-agent',
    reason: 'Ready tasks must not gain dependencies after admission.',
    dependsOn: 'TEST-001;TEST-003',
  }));
  assert.equal(readyDependencyRevision.response.status, 409);

  const normalPacket = await request('/api/tasks/TEST-003/packet');
  const normalStart = await request('/api/runs/start', mutation({
    taskId: 'TEST-003',
    trackerRevision: normalPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Normal managed-run lifecycle test only',
    expectedBehavior: 'A Ready task reaches In Review through a durable Run.',
  }));
  assert.equal(normalStart.response.status, 201);
  const normalClose = await request(`/api/tasks/TEST-003/runs/${normalStart.body.run.runId}/close`, mutation({
    trackerRevision: normalStart.body.trackerRevision,
    outcome: 'verified',
    summary: 'Normal managed lifecycle passed in an isolated CSV fixture.',
  }));
  assert.equal(normalClose.response.status, 200);
  assert.equal(normalClose.body.task.Status, 'In Review');
  const postCloseArtifact = await request(`/api/tasks/TEST-003/runs/${normalStart.body.run.runId}/artifacts`, mutation({
    trackerRevision: normalClose.body.trackerRevision,
    name: 'late',
    content: 'This must reject after close.',
  }));
  assert.equal(postCloseArtifact.response.status, 409);
  const blockedReviewClaim = await request('/api/tasks/TEST-003/review', mutation({ trackerRevision: normalClose.body.trackerRevision, action: 'claim', reviewer: 'independent-reviewer' }));
  assert.equal(blockedReviewClaim.response.status, 200);
  const blockedReview = await request('/api/tasks/TEST-003/review', mutation({ trackerRevision: blockedReviewClaim.body.trackerRevision, action: 'decision', reviewer: 'independent-reviewer', decision: 'blocked', blocker: 'Frozen-rule conflict requires owner decision.', notes: 'Review records a concrete external/frozen-rule blocker.' }));
  assert.equal(blockedReview.response.status, 200);
  assert.equal(blockedReview.body.task.Status, 'Blocked');

  const claimRecoveryPacket = await request('/api/tasks/TEST-004/packet');
  const interruptedClaim = await request('/api/runs/start', mutation({
    taskId: 'TEST-004',
    trackerRevision: claimRecoveryPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Claim recovery test only',
    expectedBehavior: 'A failure before CSV replacement preserves the Run ID without claiming the task.',
  }));
  assert.equal(interruptedClaim.response.status, 500);
  const recoveredClaim = await request('/api/runs/start', mutation({
    taskId: 'TEST-004',
    trackerRevision: claimRecoveryPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Retry after claim recovery',
    expectedBehavior: 'The abandoned prior Run ID is not reused.',
  }));
  assert.equal(recoveredClaim.response.status, 201);
  assert.equal(recoveredClaim.body.run.runId, 'TEST-004-R0002');
  assert.match(await readFile(join(recordsPath, 'TEST-004', 'TEST-004-R0001', 'run.json'), 'utf8'), /"status": "Abandoned"/);

  const committedClaimPacket = await request('/api/tasks/TEST-005/packet');
  const committedClaimFailure = await request('/api/runs/start', mutation({
    taskId: 'TEST-005',
    trackerRevision: committedClaimPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Committed claim recovery test',
    expectedBehavior: 'A post-CSV failure leaves a recoverable stale claim intent.',
  }));
  assert.equal(committedClaimFailure.response.status, 500);
  const committedPacket = await request('/api/tasks/TEST-005/packet');
  assert.equal(committedPacket.body.task.Status, 'In Progress');
  const committedClose = await request('/api/tasks/TEST-005/runs/TEST-005-R0001/close', mutation({
    trackerRevision: committedPacket.body.trackerRevision,
    outcome: 'verified',
    summary: 'Close the Run that retained a post-CSV claim intent.',
  }));
  assert.equal(committedClose.response.status, 200);
  const committedReviewClaim = await request('/api/tasks/TEST-005/review', mutation({
    trackerRevision: committedClose.body.trackerRevision,
    action: 'claim',
    reviewer: 'independent-reviewer',
  }));
  assert.equal(committedReviewClaim.response.status, 200);
  const committedReviewReject = await request('/api/tasks/TEST-005/review', mutation({
    trackerRevision: committedReviewClaim.body.trackerRevision,
    action: 'decision',
    reviewer: 'independent-reviewer',
    decision: 'rejected',
    notes: 'Exercise retry after a reviewed Run, retaining its evidence but returning task to Ready.',
  }));
  assert.equal(committedReviewReject.response.status, 200);
  const committedRetry = await request('/api/runs/start', mutation({
    taskId: 'TEST-005',
    trackerRevision: committedReviewReject.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Retry after stale committed claim intent',
    expectedBehavior: 'Stale claim intent is cleared and Run ID advances.',
  }));
  assert.equal(committedRetry.response.status, 201);
  assert.equal(committedRetry.body.run.runId, 'TEST-005-R0002');
  const preclaimPacket = await request('/api/tasks/TEST-006/packet');
  const preclaimBlock = await request('/api/tasks/TEST-006/block', mutation({ trackerRevision: preclaimPacket.body.trackerRevision, agent: 'test-agent', blocker: 'Required fixture schema is absent.', evidence: 'Packet SpecRef cannot be resolved in this isolated fixture.' }));
  assert.equal(preclaimBlock.response.status, 200);
  assert.equal(preclaimBlock.body.task.Status, 'Blocked');
  const blockedPreclaimPacket = await request('/api/tasks/TEST-006/packet');
  assert.equal(blockedPreclaimPacket.body.packet.existingRuns.length, 0);
  const dependencyPacket = await request('/api/tasks/TEST-007/packet');
  const dependencyUnblock = await request('/api/tasks/TEST-007/unblock', mutation({ trackerRevision: dependencyPacket.body.trackerRevision, agent: 'scheduler-agent', reason: 'TEST-001 is independently Done and is the only dependency.' }));
  assert.equal(dependencyUnblock.response.status, 200);
  assert.equal(dependencyUnblock.body.task.Status, 'Ready');
  assert.equal(dependencyUnblock.body.task.Implementer, '');
  assert.equal(dependencyUnblock.body.task.ReviewClaim, '');
  assert.match(dependencyUnblock.body.task.Evidence, /UNBLOCKED: TEST-001;/);
  const dependencyUnblockedPacket = await request('/api/tasks/TEST-007/packet');
  assert.equal(dependencyUnblockedPacket.body.packet.existingRuns.length, 0);
  const zeroDependencyPacket = await request('/api/tasks/TEST-008/packet');
  const zeroDependencyUnblock = await request('/api/tasks/TEST-008/unblock', mutation({ trackerRevision: zeroDependencyPacket.body.trackerRevision, agent: 'scheduler-agent', reason: 'Must reject because no completed dependency released it.' }));
  assert.equal(zeroDependencyUnblock.response.status, 409);
  const unfinishedDependencyPacket = await request('/api/tasks/TEST-009/packet');
  const unfinishedDependencyUnblock = await request('/api/tasks/TEST-009/unblock', mutation({ trackerRevision: unfinishedDependencyPacket.body.trackerRevision, agent: 'scheduler-agent', reason: 'Must reject because TEST-002 remains In Progress.' }));
  assert.equal(unfinishedDependencyUnblock.response.status, 409);
  const parkingPacket = await request('/api/tasks/TEST-009/packet');
  const parked = await request('/api/tasks/TEST-009/park', mutation({ trackerRevision: parkingPacket.body.trackerRevision, agent: 'scheduler-agent', reason: 'TEST-009 belongs to a later execution window and must not inflate active blocker monitoring.' }));
  assert.equal(parked.response.status, 200);
  assert.equal(parked.body.task.Status, 'Backlog');
  assert.equal(parked.body.task.Blocker, '');
  assert.match(parked.body.task.Evidence, /PARKED: Blocked -> Backlog;/);
  const prematureAdmission = await request('/api/tasks/TEST-009/admit', mutation({ trackerRevision: parked.body.trackerRevision, agent: 'scheduler-agent', targetStatus: 'Ready', reason: 'This must reject because TEST-002 remains unfinished.' }));
  assert.equal(prematureAdmission.response.status, 409);
  const admittedBlocked = await request('/api/tasks/TEST-009/admit', mutation({ trackerRevision: parked.body.trackerRevision, agent: 'scheduler-agent', targetStatus: 'Blocked', blocker: 'TEST-002 remains In Progress in the admitted near-term chain.', reason: 'The caller explicitly admits TEST-009 for dependency monitoring.' }));
  assert.equal(admittedBlocked.response.status, 200);
  assert.equal(admittedBlocked.body.task.Status, 'Blocked');
  assert.match(admittedBlocked.body.task.Evidence, /ADMITTED: Backlog -> Blocked;/);
  const ownerWaitPacket = await request('/api/tasks/TEST-010/packet');
  const ownerWaitStart = await request('/api/runs/start', mutation({
    taskId: 'TEST-010',
    trackerRevision: ownerWaitPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Generic owner-wait close test',
    expectedBehavior: 'The caller explicitly selects an allowed owner-facing status.',
  }));
  assert.equal(ownerWaitStart.response.status, 201);
  const invalidDecisionOwnerVerification = await request(`/api/tasks/TEST-010/runs/${ownerWaitStart.body.run.runId}/close`, mutation({
    trackerRevision: ownerWaitStart.body.trackerRevision,
    outcome: 'verified',
    summary: 'A DecisionOwner task must not enter the independent-review completion route.',
  }));
  assert.equal(invalidDecisionOwnerVerification.response.status, 409);
  const missingOwnerStatus = await request(`/api/tasks/TEST-010/runs/${ownerWaitStart.body.run.runId}/close`, mutation({
    trackerRevision: ownerWaitStart.body.trackerRevision,
    outcome: 'awaiting-human',
    summary: 'This must reject without an explicit owner status.',
  }));
  assert.equal(missingOwnerStatus.response.status, 409);
  const ownerWaitClose = await request(`/api/tasks/TEST-010/runs/${ownerWaitStart.body.run.runId}/close`, mutation({
    trackerRevision: ownerWaitStart.body.trackerRevision,
    outcome: 'awaiting-human',
    ownerStatus: 'Awaiting Owner',
    summary: 'Generic owner-wait status was explicitly supplied.',
  }));
  assert.equal(ownerWaitClose.response.status, 200);
  assert.equal(ownerWaitClose.body.task.Status, 'Awaiting Owner');
  const authorityPacket = await request('/api/tasks/TEST-012/packet');
  const authorityStart = await request('/api/runs/start', mutation({
    taskId: 'TEST-012',
    trackerRevision: authorityPacket.body.trackerRevision,
    agent: 'authority-agent',
    verificationProfile: 'A-Governance',
    scope: 'Expose one direct owner dependency under an auditable active authority Run.',
    expectedBehavior: 'Only the Agent holding the active authority Run can transition its direct DecisionOwner dependency into an explicit owner wait.',
  }));
  assert.equal(authorityStart.response.status, 201);
  const prematureOwnerWait = await request('/api/tasks/TEST-013/owner-wait', mutation({
    trackerRevision: authorityStart.body.trackerRevision,
    authorityTaskId: 'TEST-012',
    agent: 'wrong-agent',
    ownerStatus: 'Awaiting Owner',
    reason: 'This must reject because the authority claim belongs to another agent.',
  }));
  assert.equal(prematureOwnerWait.response.status, 409);
  const ownerWaitActivation = await request('/api/tasks/TEST-013/owner-wait', mutation({
    trackerRevision: authorityStart.body.trackerRevision,
    authorityTaskId: 'TEST-012',
    agent: 'authority-agent',
    ownerStatus: 'Awaiting Owner',
    reason: 'The Agent holding the active authority Run verified that this direct owner preparation is required.',
  }));
  assert.equal(ownerWaitActivation.response.status, 200);
  assert.equal(ownerWaitActivation.body.task.Status, 'Awaiting Owner');
  assert.match(ownerWaitActivation.body.task.Evidence, /OWNER-WAIT ACTIVATED: TEST-012;/);
  const closedBlockPacket = await request('/api/tasks/TEST-011/packet');
  const closedBlockStart = await request('/api/runs/start', mutation({
    taskId: 'TEST-011',
    trackerRevision: closedBlockPacket.body.trackerRevision,
    agent: 'test-agent',
    verificationProfile: 'A-Design',
    scope: 'Closed blocked Run recovery test',
    expectedBehavior: 'A completed blocked Run must not permanently prevent generic dependency-unblock.',
  }));
  assert.equal(closedBlockStart.response.status, 201);
  const closedBlockClose = await request(`/api/tasks/TEST-011/runs/${closedBlockStart.body.run.runId}/close`, mutation({
    trackerRevision: closedBlockStart.body.trackerRevision,
    outcome: 'blocked',
    blocker: 'Awaiting independent contract remediation.',
    summary: 'The Run closed with a concrete blocker and retained its historical Implementer attribution.',
  }));
  assert.equal(closedBlockClose.response.status, 200);
  assert.equal(closedBlockClose.body.task.Status, 'Blocked');
  assert.equal(closedBlockClose.body.task.Implementer, 'test-agent');
  const closedBlockDependencyRevision = await request('/api/tasks/TEST-011/dependencies', mutation({
    trackerRevision: closedBlockClose.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'A closed blocked Run is historical attribution, so an Agent can record a newly discovered prerequisite before retry.',
    dependsOn: 'TEST-001;TEST-003',
  }));
  assert.equal(closedBlockDependencyRevision.response.status, 200);
  assert.equal(closedBlockDependencyRevision.body.task.Status, 'Blocked');
  assert.equal(closedBlockDependencyRevision.body.task.Implementer, 'test-agent');
  assert.equal(closedBlockDependencyRevision.body.task.DependsOn, 'TEST-001;TEST-003');
  const closedBlockDependencyRestore = await request('/api/tasks/TEST-011/dependencies', mutation({
    trackerRevision: closedBlockDependencyRevision.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'Restore the independently completed prerequisite before generic unblock verification.',
    dependsOn: 'TEST-001',
  }));
  assert.equal(closedBlockDependencyRestore.response.status, 200);
  const closedBlockUnblock = await request('/api/tasks/TEST-011/unblock', mutation({
    trackerRevision: closedBlockDependencyRestore.body.trackerRevision,
    agent: 'scheduler-agent',
    reason: 'The independent blocker is resolved and TEST-001 remains Done.',
  }));
  assert.equal(closedBlockUnblock.response.status, 200);
  assert.equal(closedBlockUnblock.body.task.Status, 'Ready');
  assert.equal(closedBlockUnblock.body.task.Implementer, '');
  console.log(`managed-run test passed: recovered ${runId}, normal ${normalStart.body.run.runId}, non-reused claims TEST-004-R0002 and TEST-005-R0002`);
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit').catch(() => {});
  await rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => { /* a busy temp folder is not a test failure */ });
}
