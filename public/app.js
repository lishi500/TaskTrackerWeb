const state = { records: [], summary: null, selectedTaskId: null };
const ownerStatuses = new Set(['Awaiting Owner', 'Awaiting Owner Gate', 'Awaiting Agent Evaluation']);

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

function statusBadge(status) {
  return element('span', `status status-${status.toLowerCase().replaceAll(/[^a-z]+/g, '-')}`, status);
}

function findTask(taskId) { return state.records.find((record) => record.TaskID === taskId); }

function openTask(taskId) {
  state.selectedTaskId = taskId;
  const task = findTask(taskId);
  if (!task) return;
  const target = document.querySelector('#task-detail');
  target.replaceChildren();
  target.append(element('p', 'eyebrow', task.Workstream || 'TASK'));
  target.append(element('h2', null, `${task.TaskID} · ${task.Task}`));
  target.append(statusBadge(task.Status));
  const metadata = [
    ['Milestone', task.Milestone], ['Owner role', task.OwnerRole], ['Priority', task.Priority],
    ['SpecRef', task.SpecRef], ['DependsOn', task.DependsOn || '无'], ['Blocker', task.Blocker || '无'],
    ['Acceptance', task.Acceptance], ['Evidence', task.Evidence || '暂无'],
  ];
  const details = element('dl', 'task-details');
  for (const [label, value] of metadata) {
    details.append(element('dt', null, label));
    details.append(element('dd', null, value));
  }
  target.append(details);
  if (ownerStatuses.has(task.Status)) target.append(feedbackForm(task));
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
      const response = await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.TaskID, feedback: textarea.value }) });
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
    const action = element('button', 'primary-button', task.Status === 'Awaiting Agent Evaluation' ? '查看或补充反馈' : '处理此项');
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
  const query = document.querySelector('#task-search').value.trim().toLowerCase();
  const target = document.querySelector('#task-table-body'); target.replaceChildren();
  const filtered = state.records.filter((task) => !query || [task.TaskID, task.Task, task.Status, task.Blocker, task.Milestone].join(' ').toLowerCase().includes(query));
  for (const task of filtered) {
    const row = document.createElement('tr');
    const cells = [task.TaskID, task.Milestone, task.Task, task.Status, task.DependsOn || '—', task.Updated || '—'];
    cells.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 0) cell.append(renderTaskLink(task));
      else if (index === 3) cell.append(statusBadge(value));
      else cell.textContent = value;
      row.append(cell);
    });
    row.addEventListener('click', () => openTask(task.TaskID)); target.append(row);
  }
}

function render() {
  document.querySelector('#total-count').textContent = state.summary.total;
  document.querySelector('#owner-count').textContent = state.summary.ownerActions.length;
  document.querySelector('#work-count').textContent = state.summary.currentWork.length;
  document.querySelector('#blocked-count').textContent = state.summary.blockers.length;
  renderOwnerActions();
  renderCompactList('#current-work', state.summary.currentWork, '当前没有 Agent 正在处理的任务。');
  renderCompactList('#blockers', state.summary.blockers, '当前没有受阻任务。');
  renderTable();
}

async function load() {
  try {
    const [trackerResponse, summaryResponse] = await Promise.all([fetch('/api/tracker'), fetch('/api/summary')]);
    const tracker = await trackerResponse.json(); const summary = await summaryResponse.json();
    if (!trackerResponse.ok) throw new Error(tracker.error || '无法读取任务数据。');
    if (!summaryResponse.ok) throw new Error(summary.error || '无法读取任务概况。');
    state.records = tracker.records; state.summary = summary; render();
    if (!document.querySelector('#load-message').classList.contains('error')) setMessage(`已读取 ${summary.generatedAt.replace('T', ' ').replace('Z', ' UTC')} 的 CSV 数据。`);
  } catch (error) { setMessage(error.message, true); }
}

document.querySelector('#refresh-button').addEventListener('click', load);
document.querySelector('#task-search').addEventListener('input', renderTable);
load();
