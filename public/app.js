const state = { records: [], summary: null, issues: null, issuesError: '', instance: { projectName: 'Task Tracker' }, trackerRevision: '', selectedTaskId: null, openMilestones: new Set(), milestoneViewInitialized: false };
const ownerStatuses = new Set(['Awaiting Owner', 'Awaiting Owner Gate', 'Awaiting Agent Evaluation']);
const activeMilestoneStatuses = new Set(['Awaiting Owner', 'Awaiting Owner Gate', 'Awaiting Agent Evaluation', 'In Progress', 'In Review']);
const statusOrder = ['In Progress', 'In Review', 'Awaiting Agent Evaluation', 'Awaiting Owner', 'Awaiting Owner Gate', 'Ready', 'Blocked', 'Done', 'Deferred', 'Backlog'];
const statusLabels = {
  'In Progress': '进行中', 'In Review': '待审查', 'Awaiting Agent Evaluation': '待 Agent 评估',
  'Awaiting Owner': '待 Owner', 'Awaiting Owner Gate': '待 Owner Gate', 'Ready': '可领取',
  'Blocked': '受阻', 'Done': '已完成', 'Deferred': '已延期', 'Backlog': '待排期',
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function setMessage(message = '', isError = false) {
  const target = document.querySelector('#load-message');
  target.textContent = message;
  target.classList.toggle('error', isError);
}

function renderInstanceIdentity() {
  const projectName = state.instance.projectName || 'Task Tracker';
  document.title = `${projectName} · Task Tracker`;
  document.querySelector('#instance-heading').textContent = `${projectName} 开发任务看板`;
  const projectId = state.instance.projectId ? ` · ${state.instance.projectId}` : '';
  document.querySelector('#instance-eyebrow').textContent = `TASKTRACKERWEB${projectId}`;
}

function statusBadge(status) {
  return element('span', `status status-${status.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`, status);
}

function taskType(task) {
  return ['Task', 'Bug', 'Story'].includes(task.TaskType) ? task.TaskType : 'Task';
}

function taskTypeBadge(task) {
  const type = taskType(task);
  return element('span', `task-type task-type-${type.toLowerCase()}`, type);
}

function storyChildSummary(task) {
  const children = state.records.filter((candidate) => candidate.ParentID === task.TaskID);
  if (!children.length) return '尚未拆分子项';
  const active = children.filter((candidate) => ['In Progress', 'In Review'].includes(candidate.Status)).length;
  const blocked = children.filter((candidate) => candidate.Status === 'Blocked').length;
  const parts = [`${children.length} 个子项`];
  if (active) parts.push(`${active} 进行中`);
  if (blocked) parts.push(`${blocked} 受阻`);
  return parts.join(' · ');
}

function findTask(taskId) { return state.records.find((record) => record.TaskID === taskId); }

function runLabel(run) {
  if (!run) return '暂无执行记录';
  const outcome = run.outcome ? ` · ${run.outcome}` : '';
  return `${run.runId} · ${run.status}${outcome}`;
}

function artifactUrl(taskId, runId, name) {
  const artifactPath = name.split('/').map(encodeURIComponent).join('/');
  return `/api/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/artifacts/${artifactPath}`;
}

function renderRunSummary(task) {
  const summary = task.RunSummary;
  if (!summary) return null;
  const note = element('p', 'run-summary');
  const focus = summary.current || summary.latest;
  note.textContent = `Agent 执行 ${summary.count} 次 · ${runLabel(focus)}`;
  return note;
}

async function renderRunPanel(task, target) {
  target.replaceChildren(element('p', 'muted', '正在读取 Agent 执行记录…'));
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.TaskID)}/runs`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法读取执行记录。');
    target.replaceChildren();
    target.append(element('h3', null, `Agent 执行记录（${payload.runs.length}）`));
    if (!payload.runs.length) {
      target.append(element('p', 'muted', '尚未为此任务分配 Agent Run。'));
      return;
    }
    for (const run of payload.runs) {
      const item = document.createElement('details');
      item.className = 'run-record';
      const summary = element('summary', null, runLabel(run));
      item.append(summary);
      const body = element('div', 'run-record-body');
      body.append(element('p', 'muted', `Profile: ${run.verificationProfile || '未记录'} · Agent: ${run.agent || '未记录'}`));
      if (run.summary) body.append(element('p', null, run.summary));
      if (run.blocker) body.append(element('p', 'run-blocker', `阻塞：${run.blocker}`));
      const meta = element('p', 'muted', `开始：${run.startedAt || '—'} · 结束：${run.closedAt || '进行中'}`);
      body.append(meta);
      const artifactList = element('div', 'run-artifacts');
      if (run.artifacts?.length) {
        artifactList.append(element('strong', null, '证据文件'));
        for (const artifact of run.artifacts) {
          const link = document.createElement('a');
          link.href = artifactUrl(task.TaskID, run.runId, artifact.name);
          link.target = '_blank'; link.rel = 'noopener'; link.textContent = artifact.name;
          artifactList.append(link);
        }
      }
      const eventsButton = element('button', 'secondary-button run-events-button', '查看执行事件');
      eventsButton.type = 'button';
      const events = element('pre', 'run-events'); events.hidden = true;
      eventsButton.addEventListener('click', async () => {
        eventsButton.disabled = true;
        try {
          const detailResponse = await fetch(`/api/tasks/${encodeURIComponent(task.TaskID)}/runs/${encodeURIComponent(run.runId)}`);
          const detail = await detailResponse.json();
          if (!detailResponse.ok) throw new Error(detail.error || '无法读取执行事件。');
          events.textContent = detail.events.map((event) => JSON.stringify(event)).join('\n');
          events.hidden = false;
        } catch (error) { events.textContent = error.message; events.hidden = false; }
        finally { eventsButton.disabled = false; }
      });
      body.append(artifactList, eventsButton, events);
      item.append(body); target.append(item);
    }
  } catch (error) {
    target.replaceChildren(element('p', 'run-blocker', error.message));
  }
}

function openTask(taskId) {
  state.selectedTaskId = taskId;
  const task = findTask(taskId);
  if (!task) return;
  const target = document.querySelector('#task-detail');
  target.replaceChildren();
  target.append(element('p', 'eyebrow', `${taskType(task).toUpperCase()} · ${task.Workstream || 'TASK'}`));
  target.append(element('h2', null, `${task.TaskID} · ${task.Task}`));
  target.append(taskTypeBadge(task), statusBadge(task.Status));
  const metadata = [
    ['Type', taskType(task)], ['Milestone', task.Milestone], ['ParentID', task.ParentID || '无'], ['Owner role', task.OwnerRole], ['Priority', task.Priority],
    ['SpecRef', task.SpecRef], ['DependsOn', task.DependsOn || '无'], ['Blocker', task.Blocker || '无'],
    ['Acceptance', task.Acceptance], ['Evidence', task.Evidence || '暂无'],
  ];
  if (taskType(task) === 'Story') metadata.splice(3, 0, ['Child items', storyChildSummary(task)]);
  const details = element('dl', 'task-details');
  for (const [label, value] of metadata) {
    details.append(element('dt', null, label));
    details.append(element('dd', null, value));
  }
  target.append(details);
  const parentStory = findTask(task.ParentID);
  if (parentStory && taskType(parentStory) === 'Story') {
    const context = element('section', 'scope-context');
    context.append(element('h3', null, '所属 Story 范围'), renderTaskLink(parentStory));
    context.append(element('p', null, parentStory.Acceptance), element('p', 'muted', `契约：${parentStory.SpecRef}`));
    context.append(element('p', 'muted', 'Story 提供目标背景；本任务的授权范围与验收仍以自身契约为准。'));
    target.append(context);
  }
  if (taskType(task) === 'Story') {
    const context = element('section', 'scope-context');
    context.append(element('h3', null, '范围内的工作项'));
    context.append(element('p', 'muted', 'Story 不可执行。子项完成数量不代表玩家能力已通过验收；整体行为应由明确的 Task 验证。'));
    const children = state.records.filter((candidate) => taskType(candidate) !== 'Story' && candidate.ParentID === task.TaskID);
    if (!children.length) context.append(element('p', 'muted', '尚未拆分子项。'));
    for (const child of children) {
      const row = element('p'); row.append(renderTaskLink(child), statusBadge(child.Status)); context.append(row);
    }
    target.append(context);
  }
  if (taskType(task) !== 'Story') {
    const runPanel = element('section', 'run-panel');
    target.append(runPanel);
    void renderRunPanel(task, runPanel);
  }
  if (taskType(task) !== 'Story' && ownerStatuses.has(task.Status)) target.append(feedbackForm(task));
  document.querySelector('#task-dialog').showModal();
}

function feedbackForm(task) {
  const section = element('section', 'feedback-section');
  section.append(element('h3', null, task.Status === 'Awaiting Agent Evaluation' ? '补充反馈' : '提交反馈'));
  section.append(element('p', 'feedback-note', '提交后将写入该任务的 Evidence，并转为“等待 Agent 评估”。不会直接完成任务或解锁依赖。'));
  const form = element('form', 'feedback-form');
  const label = element('label', null, '你的反馈');
  const textarea = document.createElement('textarea');
  textarea.name = 'feedback'; textarea.required = true; textarea.maxLength = 8000;
  textarea.placeholder = task.TaskID.startsWith('DEC-') ? '例如：DEC-008: Option 1 approved' : '写下验收、准备完成情况或修改意见';
  label.append(textarea); form.append(label);
  const button = element('button', 'primary-button', '提交并等待评估'); button.type = 'submit'; form.append(button);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    setMessage('正在写入反馈…');
    try {
      const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.TaskID, feedback: textarea.value, trackerRevision: state.trackerRevision }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '提交失败。');
      document.querySelector('#task-dialog').close();
      setMessage(`${task.TaskID} 的反馈已记录，等待 Agent 评估。`);
      await load();
    } catch (error) {
      setMessage(error.message, true);
    } finally { button.disabled = false; }
  });
  section.append(form);
  return section;
}

function renderTaskLink(task) {
  const button = element('button', 'task-link', `${task.TaskID} · ${task.Task}`);
  button.type = 'button'; button.addEventListener('click', () => openTask(task.TaskID));
  return button;
}

function filteredTasks() {
  const query = document.querySelector('#task-search').value.trim().toLowerCase();
  if (!query) return state.records;
  return state.records.filter((task) => [task.TaskID, taskType(task), task.Task, task.Status, task.Blocker, task.Milestone].join(' ').toLowerCase().includes(query));
}

function milestoneCompare(left, right) {
  const parse = (value) => /^M(\d+)$/.exec(value || '');
  const leftMatch = parse(left); const rightMatch = parse(right);
  if (leftMatch && rightMatch) return Number(leftMatch[1]) - Number(rightMatch[1]);
  if (leftMatch) return -1;
  if (rightMatch) return 1;
  return (left || '').localeCompare(right || '', 'zh-CN');
}

function milestoneStatusSummary(tasks) {
  const target = element('div', 'milestone-status-summary');
  target.append(element('span', 'milestone-total', `总计 ${tasks.length}`));
  const counts = new Map();
  for (const task of tasks) counts.set(task.Status, (counts.get(task.Status) || 0) + 1);
  const ordered = [...statusOrder, ...[...counts.keys()].filter((status) => !statusOrder.includes(status)).sort()];
  for (const status of ordered) {
    const count = counts.get(status) || 0;
    if (!count) continue;
    target.append(element('span', `milestone-status-count status-${status.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`, `${statusLabels[status] || status} ${count}`));
  }
  return target;
}

function renderMilestoneTask(task) {
  const row = element('article', 'milestone-task');
  const heading = element('div', 'milestone-task-heading');
  heading.append(renderTaskLink(task), taskTypeBadge(task), statusBadge(task.Status)); row.append(heading);
  const metadata = [];
  if (taskType(task) === 'Story') metadata.push(storyChildSummary(task));
  if (task.Priority) metadata.push(task.Priority);
  if (task.DependsOn) metadata.push(`依赖 ${task.DependsOn.split(';').filter(Boolean).length} 项`);
  if (task.Updated) metadata.push(`更新 ${task.Updated}`);
  if (metadata.length) row.append(element('p', 'milestone-task-meta', metadata.join(' · ')));
  if (task.Blocker) row.append(element('p', 'muted milestone-task-blocker', task.Blocker));
  const runSummary = renderRunSummary(task); if (runSummary) row.append(runSummary);
  row.addEventListener('click', (event) => { if (!event.target.closest('button')) openTask(task.TaskID); });
  return row;
}

function renderMilestones() {
  const target = document.querySelector('#milestone-groups'); target.replaceChildren();
  const tasks = filteredTasks();
  if (!tasks.length) { target.append(element('p', 'empty-state', '没有与搜索条件匹配的任务。')); return; }
  const groups = new Map();
  for (const task of tasks) {
    const milestone = task.Milestone || '未归属';
    if (!groups.has(milestone)) groups.set(milestone, []);
    groups.get(milestone).push(task);
  }
  const queryActive = Boolean(document.querySelector('#task-search').value.trim());
  for (const [milestone, groupTasks] of [...groups.entries()].sort(([left], [right]) => milestoneCompare(left, right))) {
    const section = element('details', 'milestone-group');
    const hasActiveTask = groupTasks.some((task) => activeMilestoneStatuses.has(task.Status));
    section.open = queryActive || state.openMilestones.has(milestone) || (!state.milestoneViewInitialized && hasActiveTask);
    const summary = element('summary', 'milestone-summary');
    const title = element('div', 'milestone-title');
    title.append(element('span', 'milestone-name', milestone)); title.append(element('span', 'milestone-caption', '任务状态'));
    summary.append(title); summary.append(milestoneStatusSummary(groupTasks)); section.append(summary);
    const body = element('div', 'milestone-task-list');
    for (const task of [...groupTasks].sort((left, right) => (left.Priority || '').localeCompare(right.Priority || '') || left.TaskID.localeCompare(right.TaskID))) body.append(renderMilestoneTask(task));
    section.append(body);
    section.addEventListener('toggle', () => { if (section.open) state.openMilestones.add(milestone); else state.openMilestones.delete(milestone); });
    target.append(section);
  }
  state.milestoneViewInitialized = true;
}

function renderOwnerActions() {
  const target = document.querySelector('#owner-actions'); target.replaceChildren();
  if (!state.summary.ownerActions.length) {
    target.append(element('p', 'empty-state', '当前没有等待你处理的任务。'));
    return;
  }
  for (const task of state.summary.ownerActions) {
    const card = element('article', 'action-card');
    card.append(statusBadge(task.Status)); card.append(renderTaskLink(task));
    if (task.Blocker) card.append(element('p', 'muted', task.Blocker));
    const action = element('button', 'primary-button', '处理此项');
    action.type = 'button'; action.addEventListener('click', () => openTask(task.TaskID)); card.append(action);
    target.append(card);
  }
}

function renderClaimableSessions() {
  const target = document.querySelector('#claimable-sessions'); target.replaceChildren();
  const claimable = state.records.filter((task) => task.Status === 'Ready' && taskType(task) !== 'Story');
  if (!claimable.length) {
    target.append(element('p', 'empty-state', '当前没有可领取的任务。'));
    return;
  }
  for (const task of [...claimable].sort((left, right) => milestoneCompare(left.Milestone, right.Milestone) || (left.Priority || '').localeCompare(right.Priority || '') || left.TaskID.localeCompare(right.TaskID))) {
    const card = element('article', 'action-card claimable-card');
    card.append(statusBadge(task.Status)); card.append(renderTaskLink(task));
    const metadata = [task.Milestone || '未归属'];
    if (task.Priority) metadata.push(task.Priority);
    if (task.DependsOn) metadata.push(`依赖 ${task.DependsOn.split(';').filter(Boolean).length} 项`);
    card.append(element('p', 'muted', metadata.join(' · ')));
    if (task.Acceptance) card.append(element('p', 'claimable-acceptance', `验收：${task.Acceptance}`));
    const action = element('button', 'secondary-button', '查看领取条件');
    action.type = 'button'; action.addEventListener('click', () => openTask(task.TaskID)); card.append(action);
    target.append(card);
  }
}

function renderCompactList(selector, tasks, emptyText) {
  const target = document.querySelector(selector); target.replaceChildren();
  if (!tasks.length) { target.append(element('p', 'empty-state', emptyText)); return; }
  for (const task of tasks.slice(0, 8)) {
    const row = element('article', 'compact-item'); row.append(renderTaskLink(task)); row.append(statusBadge(task.Status));
    if (task.Blocker) row.append(element('p', 'muted', task.Blocker)); target.append(row);
  }
}

function renderTable() {
  const target = document.querySelector('#task-table-body'); target.replaceChildren();
  for (const task of filteredTasks()) {
    const row = document.createElement('tr');
    const latestRun = task.RunSummary?.current || task.RunSummary?.latest;
    const cells = [task.TaskID, taskType(task), task.Milestone, task.Task, task.Status, runLabel(latestRun), task.DependsOn || '—', task.Updated || '—'];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 0) cell.append(renderTaskLink(task));
      else if (index === 1) cell.append(taskTypeBadge(task));
      else if (index === 4) cell.append(statusBadge(value));
      else cell.textContent = value;
      row.append(cell);
    });
    row.addEventListener('click', () => openTask(task.TaskID)); target.append(row);
  }
}

function issueCountLabel(issue) {
  return issue.acknowledgedReportCount > 0
    ? `${issue.unacknowledgedCount} (${issue.acknowledgedReportCount})`
    : String(issue.unacknowledgedCount);
}

function renderToolchainIssues() {
  const target = document.querySelector('#toolchain-issues');
  target.replaceChildren();
  document.querySelector('#toolchain-alert-count').textContent = state.issuesError || !state.issues ? '—' : state.issues.activeIssueCount;
  if (state.issuesError || !state.issues) {
    target.append(element('p', state.issuesError ? 'run-blocker' : 'muted', state.issuesError || '正在读取工具链报警…'));
    return;
  }
  if (!state.issues.issues.length) {
    target.append(element('p', 'empty-state', document.querySelector('#include-acknowledged').checked ? '尚无工具链报警记录。' : '当前没有未确认的工具链报警。'));
    return;
  }
  for (const issue of state.issues.issues) {
    const card = element('article', 'toolchain-issue-card');
    const heading = element('div', 'toolchain-issue-heading');
    heading.append(element('code', 'failure-key', issue.failureKey), element('span', 'issue-count', issueCountLabel(issue)));
    card.append(heading, element('p', 'toolchain-issue-summary', issue.summary));
    card.append(element('p', 'muted', `${issue.toolchain} · ${issue.operation}`));
    if (issue.detail) card.append(element('pre', 'toolchain-issue-detail', issue.detail));
    if (issue.latestEvidenceRef) card.append(element('p', 'muted', `最新证据：${issue.latestEvidenceRef}`));
    const reports = issue.recentReports.map((report) => `${report.taskId}${report.runId ? ` / ${report.runId}` : ''}`).join(' · ');
    if (reports) card.append(element('p', 'muted', `最近关联：${reports}`));
    if (issue.latestAcknowledgement) {
      const ack = issue.latestAcknowledgement;
      card.append(element('p', 'muted', `最近 ACK：${ack.acknowledger} · ${ack.timestamp} · ${ack.notes}`));
    }
    if (!issue.unacknowledgedCount) {
      card.append(element('p', 'muted', '已 ACK，保留历史；尚不能据此认定已修复。'));
      target.append(card);
      continue;
    }
    const form = element('form', 'issue-ack-form');
    const acknowledger = document.createElement('input');
    acknowledger.name = 'acknowledger'; acknowledger.required = true; acknowledger.maxLength = 256; acknowledger.placeholder = '确认人';
    const notes = document.createElement('textarea');
    notes.name = 'notes'; notes.required = true; notes.maxLength = 4000; notes.placeholder = '说明处理、排查或转交动作；ACK 不等于问题已修复。';
    const button = element('button', 'secondary-button', 'ACK 新报警'); button.type = 'submit';
    form.append(acknowledger, notes, button);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      setMessage(`正在确认 ${issue.failureKey} 的新报警…`);
      try {
        const response = await fetch(`/api/toolchain-issues/${encodeURIComponent(issue.failureKey)}/ack`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ acknowledger: acknowledger.value, notes: notes.value, expectedReportCount: issue.totalReportCount }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(response.status === 409 ? '报警已变化，请刷新并查看新报告后再 ACK。' : payload.error || '确认工具链报警失败。');
        setMessage(`${issue.failureKey} 的新报警已 ACK；历史报告会被保留。`);
        await load();
      } catch (error) {
        setMessage(error.message, true);
      } finally { button.disabled = false; }
    });
    card.append(form);
    target.append(card);
  }
}

function render() {
  document.querySelector('#total-count').textContent = state.summary.total;
  document.querySelector('#work-item-breakdown').textContent = `${state.summary.executableCount} 个 Task/Bug · ${state.summary.storyCount} 个 Story；数量不代表产品完成度。`;
  document.querySelector('#owner-count').textContent = state.summary.ownerActions.length;
  document.querySelector('#work-count').textContent = state.summary.currentWork.length;
  document.querySelector('#blocked-count').textContent = state.summary.blockers.length;
  renderOwnerActions();
  renderCompactList('#current-work', state.summary.currentWork, '当前没有 Agent 正在处理的任务。');
  renderCompactList('#blockers', state.summary.blockers, '当前没有受阻任务。');
  renderCompactList('#dependency-waits', state.summary.dependencyWaits, '当前没有自动排队的依赖等待。');
  renderToolchainIssues();
  renderClaimableSessions();
  renderMilestones();
  renderTable();
}

async function loadTracker() {
  try {
    const [trackerResponse, summaryResponse, instanceResponse] = await Promise.all([fetch('/api/tracker'), fetch('/api/summary'), fetch('/api/instance')]);
    const tracker = await trackerResponse.json(); const summary = await summaryResponse.json(); const instance = await instanceResponse.json();
    if (!trackerResponse.ok) throw new Error(tracker.error || '无法读取任务数据。');
    if (!summaryResponse.ok) throw new Error(summary.error || '无法读取任务概况。');
    if (!instanceResponse.ok) throw new Error(instance.error || '无法读取 Tracker 实例信息。');
    state.records = tracker.records; state.summary = summary; state.instance = instance; state.trackerRevision = tracker.revision; renderInstanceIdentity(); render();
    if (!document.querySelector('#load-message').classList.contains('error')) setMessage(`已读取 ${summary.generatedAt.replace('T', ' ').replace('Z', ' UTC')} 的 CSV 数据。`);
  } catch (error) { setMessage(error.message, true); }
}

async function loadToolchainIssues() {
  try {
    const includeAcknowledged = document.querySelector('#include-acknowledged').checked;
    const response = await fetch(`/api/toolchain-issues?includeAcknowledged=${includeAcknowledged}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法读取工具链报警。');
    state.issues = payload; state.issuesError = '';
  } catch (error) {
    state.issues = null; state.issuesError = `工具链报警暂不可用：${error.message}`;
  }
  renderToolchainIssues();
}

async function load() {
  await Promise.all([loadTracker(), loadToolchainIssues()]);
}

document.querySelector('#refresh-button').addEventListener('click', load);
document.querySelector('#task-search').addEventListener('input', () => { renderMilestones(); renderTable(); });
document.querySelector('#include-acknowledged').addEventListener('change', loadToolchainIssues);
load();
