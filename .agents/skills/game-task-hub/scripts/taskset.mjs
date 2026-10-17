// Task-set markdown -> Hub planned tasks. Used by `tt import`; no dependencies.
//
// Format (docs/tasks/<milestone>.md):
//
//   # Tasks: M1 Prototype
//   Milestone: M1            <- header (before the first "##"): Milestone, Stream, Lane, Spec
//   Stream: Gameplay
//   Lane: slice              <- slice = tracked in the Hub; prototype = checklist only, never imported
//   Spec: docs/milestones.md#m1
//
//   ## S-FISH: Cast and reel prototype      <- "## ID: title" is a Story
//   - Acceptance: player-observable outcome of the whole slice
//   ### T-001: Title                         <- "### ID: title" is a Task ("- Type: Bug" makes it a Bug)
//   - Depends: T-000; T-002                  <- ';' or ',' separated
//   - Authority: reviewer                    <- reviewer (default) | owner
//   - Priority: P1                           <- P0..P3, default P1
//   - Acceptance: one paragraph
//   - Effort / Profile / Why / Decisions / Uncertainty: informational, stay in the document
//
// The document is the source of task intent; the Hub is the source of task state.

const ID_PATTERN = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/;
const ID_PREFIX = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+(?=\s|$)/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/; // an optional closing "###" needs a space before it ("Learn C#" keeps its #)
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const COLON = '[:\\uFF1A]';
const FIELD = new RegExp(`^([A-Za-z][A-Za-z ]*?)\\s*${COLON}\\s*(.*)$`);
const HEADER_FIELD = new RegExp(`^\\s*(?:[-*+]\\s+)?(Milestone|Stream|Lane|Spec)\\s*${COLON}\\s*(.+?)\\s*$`, 'i');
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const KNOWN_FIELDS = new Map([
  ['depends', 'depends'], ['dependson', 'depends'], ['deps', 'depends'],
  ['authority', 'authority'], ['priority', 'priority'], ['acceptance', 'acceptance'],
  ['spec', 'spec'], ['type', 'type'], ['parent', 'parent'], ['milestone', 'milestone'], ['stream', 'stream'],
  ['effort', 'info'], ['profile', 'info'], ['why', 'info'], ['decisions', 'info'], ['uncertainty', 'info'],
]);

const collapse = (text) => String(text).replace(/\s+/g, ' ').trim();
// Join a wrapped continuation line; between two CJK characters no space belongs there.
const CJK_END = /[\u3000-\u9FFF\uFF00-\uFFEF]$/;
const CJK_START = /^[\u3000-\u9FFF\uFF00-\uFFEF]/;
const joinWrapped = (left, right) => {
  const next = collapse(right);
  return CJK_END.test(left) && CJK_START.test(next) ? left + next : collapse(`${left} ${next}`);
};

export const reservedNameSource = RESERVED_WINDOWS_NAME.source;
export const isValidId = (id) => ID_PATTERN.test(id) && id.length <= 128 && !RESERVED_WINDOWS_NAME.test(id) && !id.endsWith('.');

// "A; B, C" (also full-width separators) -> ['A', 'B', 'C']; "none", "-" and "无" mean no dependencies.
export function splitList(value) {
  const text = collapse(value);
  if (!text || /^(none|n\/a|-|—|无)$/i.test(text)) return [];
  return text.split(/\s*[;,；，、]\s*|\s+/).filter(Boolean);
}

export function parseTaskSet(source, { docPath = '' } = {}) {
  // Blank out HTML comments but keep the line count, so error line numbers stay right.
  const text = String(source).replace(/^\uFEFF/, '').replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ''));
  const lines = text.split(/\r?\n/);
  const header = {};
  const items = [];
  const errors = [];
  let current;
  let currentField;
  let fieldIndent;
  let story;
  let inHeader = true;

  const finishField = () => { currentField = undefined; };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const heading = HEADING.exec(rawLine);
    if (heading) {
      const level = heading[1].length;
      if (level >= 4) continue;
      if (level === 1) continue;
      inHeader = false;
      finishField();
      const headingText = collapse(heading[2]);
      const item = new RegExp(`^(\\S+?)\\s*${COLON}\\s*(.+)$`).exec(headingText);
      if (item && ID_PATTERN.test(item[1])) {
        current = { id: item[1], title: item[2], kind: level === 2 ? 'Story' : 'Task', line: lineNumber, fields: {}, parentStory: level === 3 ? story?.id : undefined };
        items.push(current);
        if (level === 2) story = current;
        fieldIndent = undefined;
      } else {
        current = undefined;
        if (item && /[-\d]|^[A-Z]+$/.test(item[1])) {
          // "ABC: x", "T001: x", "t-001: x" are meant as items; skipping them silently would lose tasks.
          errors.push({ line: lineNumber, message: `heading '${headingText.slice(0, 60)}': '${item[1]}' is not a usable id (a prefix, a hyphen and a suffix in capitals/digits, for example T-001)` });
        } else if (ID_PREFIX.test(headingText)) {
          errors.push({ line: lineNumber, message: `heading '${headingText.slice(0, 60)}' looks like an item but has no "ID: title" form (write '${level === 2 ? '##' : '###'} ${headingText.split(/\s/)[0]}: title')` });
        }
      }
      continue;
    }
    if (inHeader) {
      const field = HEADER_FIELD.exec(rawLine);
      if (field) header[field[1].toLowerCase()] = collapse(field[2]);
      continue;
    }
    if (!current) continue;
    if (rawLine.trim() === '') { finishField(); continue; }
    const bullet = BULLET.exec(rawLine);
    if (bullet) {
      const indent = bullet[1].replaceAll('\t', '    ').length;
      const asField = FIELD.exec(bullet[2]);
      const key = asField ? KNOWN_FIELDS.get(asField[1].toLowerCase().replace(/\s+/g, '')) : undefined;
      if (asField && key && (fieldIndent === undefined || indent <= fieldIndent)) {
        fieldIndent ??= indent;
        currentField = key;
        if (key !== 'info') current.fields[key] = { value: collapse(asField[2]), line: lineNumber };
        else currentField = 'info';
        continue;
      }
      if (fieldIndent !== undefined && indent <= fieldIndent) { finishField(); continue; } // another bullet at field level (e.g. "- Notes: ...")
      if (currentField && currentField !== 'info') { // nested list item under a field: "- Acceptance:" then "  - a" "  - b"
        const slot = current.fields[currentField];
        slot.value = slot.value ? `${slot.value}; ${collapse(bullet[2])}` : collapse(bullet[2]);
      }
      continue;
    }
    if (currentField && currentField !== 'info') { // wrapped text of the previous field
      const slot = current.fields[currentField];
      slot.value = joinWrapped(slot.value, rawLine);
    }
  }

  // ---- Per-item validation and normalization ----
  const seen = new Map();
  const normalized = [];
  for (const item of items) {
    const problem = (message, line = item.line) => errors.push({ line, message: `${item.id}: ${message}` });
    if (!isValidId(item.id)) problem(`'${item.id}' is not a usable id (letters, digits and hyphens, e.g. T-001; Windows device names are not allowed)`);
    if (seen.has(item.id)) problem(`duplicate id (first used on line ${seen.get(item.id)})`);
    seen.set(item.id, seen.get(item.id) ?? item.line);
    if (!item.title || item.title.length > 4000) problem('the title is empty or longer than 4000 characters');
    const field = (name) => item.fields[name]?.value ?? '';
    const lineOf = (name) => item.fields[name]?.line ?? item.line;
    let kind = item.kind;
    if (kind === 'Task' && field('type')) {
      const requested = field('type').toLowerCase();
      if (requested === 'bug') kind = 'Bug';
      else if (requested !== 'task') problem(`Type must be Task or Bug (got '${field('type')}'); Stories are written as '## ID: title'`, lineOf('type'));
    } else if (kind === 'Story' && field('type') && field('type').toLowerCase() !== 'story') {
      problem(`a '## ' heading is a Story; remove 'Type: ${field('type')}' or write the item as '### ID: title'`, lineOf('type'));
    }
    const acceptance = field('acceptance');
    if (!acceptance) problem(`Acceptance is required (one paragraph: what the reviewer or player can observe)`);
    if (acceptance.length > 8000) problem('Acceptance is longer than 8000 characters', lineOf('acceptance'));
    let authority = 'IndependentReviewerAgent';
    let ownerRole = 'Implementation agent';
    const depends = splitList(field('depends'));
    let parent = field('parent') || item.parentStory || '';
    if (kind === 'Story') {
      authority = 'NotApplicable';
      ownerRole = 'Delivery lead';
      if (depends.length) problem(`a Story cannot have Depends (it is not executable); use '### ID: title' for Tasks`, lineOf('depends'));
      if (field('parent')) problem('a Story cannot have a Parent', lineOf('parent'));
      parent = '';
    } else {
      const requested = field('authority').toLowerCase().replace(/[\s_-]/g, '');
      if (!requested || ['reviewer', 'independentrevieweragent', 'agent', 'review'].includes(requested)) authority = 'IndependentReviewerAgent';
      else if (['owner', 'decisionowner', 'human'].includes(requested)) { authority = 'DecisionOwner'; ownerRole = 'Human decision owner'; }
      else problem(`Authority must be 'reviewer' or 'owner' (got '${field('authority')}')`, lineOf('authority'));
      for (const dependency of depends) {
        if (!isValidId(dependency)) problem(`Depends entry '${dependency.slice(0, 40)}' is not a task id (separate several with ';')`, lineOf('depends'));
        if (dependency === item.id) problem('a task cannot depend on itself', lineOf('depends'));
      }
      if (new Set(depends).size !== depends.length) problem('Depends lists the same id twice', lineOf('depends'));
      if (parent && !isValidId(parent)) problem(`Parent '${parent.slice(0, 40)}' is not a task id`, lineOf('parent'));
    }
    let priority = 'P1';
    if (field('priority')) {
      priority = field('priority').toUpperCase();
      if (!/^P[0-3]$/.test(priority)) { problem(`Priority must be P0, P1, P2 or P3 (got '${field('priority')}')`, lineOf('priority')); priority = 'P1'; }
    }
    normalized.push({
      id: item.id,
      kind,
      title: item.title,
      line: item.line,
      parent,
      depends,
      authority,
      ownerRole,
      priority,
      acceptance,
      spec: field('spec'),
      milestone: field('milestone'),
      stream: field('stream'),
    });
  }

  const lane = (header.lane ?? 'slice').toLowerCase();
  if (!['slice', 'prototype'].includes(lane)) errors.push({ line: 1, message: `Lane must be 'slice' or 'prototype' (got '${header.lane}')` });
  return { header: { milestone: header.milestone ?? '', stream: header.stream ?? '', lane, spec: header.spec ?? '' }, items: normalized, errors, docPath };
}

// Decide what to create. `existing` maps taskId -> { taskType }. Returns the
// ordered creations (Stories first, then Tasks/Bugs in topological order of
// Depends, document order breaking ties) or errors; nothing is written by this
// function, so a bad file fails before the Hub is touched.
export function planImport(parsed, existing, { defaultMilestone = '' } = {}) {
  const errors = [...parsed.errors];
  const { header, items, docPath } = parsed;
  const milestone = header.milestone || defaultMilestone;
  if (!milestone) errors.push({ line: 1, message: "Milestone is required in the header (for example 'Milestone: M1') or via --milestone" });
  const inFile = new Map(items.map((item) => [item.id, item]));
  const kindOf = (id) => inFile.get(id)?.kind ?? existing.get(id)?.taskType;
  const skipped = items.filter((item) => existing.has(item.id)).map((item) => item.id);
  const fresh = items.filter((item) => !existing.has(item.id));

  for (const item of fresh) {
    const problem = (message) => errors.push({ line: item.line, message: `${item.id}: ${message}` });
    for (const dependency of item.depends) {
      const kind = kindOf(dependency);
      if (!kind) problem(`depends on ${dependency}, which is neither in this file nor in the Hub (separate dependencies with ';')`);
      else if (kind === 'Story') problem(`depends on ${dependency}, a Story; Stories are scope containers, depend on its Tasks instead`);
    }
    if (item.kind !== 'Story' && item.parent) {
      const kind = kindOf(item.parent);
      if (!kind) problem(`Parent ${item.parent} is neither in this file nor in the Hub`);
      else if (kind !== 'Story') problem(`Parent ${item.parent} is a ${kind}; a parent must be a Story`);
    }
  }

  // Order: Stories first (document order), then executable items by Depends.
  const ordered = fresh.filter((item) => item.kind === 'Story');
  const pending = fresh.filter((item) => item.kind !== 'Story');
  const emitted = new Set();
  const freshIds = new Set(fresh.map((item) => item.id));
  while (pending.length) {
    const position = pending.findIndex((item) => item.depends.every((dependency) => !freshIds.has(dependency) || emitted.has(dependency)));
    if (position < 0) {
      errors.push({ line: pending[0].line, message: `dependency cycle among ${pending.map((item) => item.id).join(', ')} (each waits for another)` });
      break;
    }
    const [next] = pending.splice(position, 1);
    emitted.add(next.id);
    ordered.push(next);
  }

  const creates = ordered.map((item) => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    payload: {
      taskId: item.id,
      taskType: item.kind,
      parentId: item.kind === 'Story' ? '' : item.parent,
      milestone: item.milestone || milestone,
      workstream: item.stream || header.stream || 'General',
      task: item.title,
      specRef: item.spec || (item.kind === 'Story' ? header.spec : '') || `${docPath || 'docs/tasks.md'}#${item.id.toLowerCase()}`,
      dependsOn: item.depends.join(';'),
      ownerRole: item.ownerRole,
      priority: item.priority,
      acceptance: item.acceptance,
      completionAuthority: item.authority,
    },
  }));
  return { creates, skipped, errors, lane: header.lane };
}
