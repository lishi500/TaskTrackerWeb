// Port policy shared by server.mjs, scripts/init-instance.mjs and scripts/start.mjs.
// The skill's tt.mjs keeps its own copy of derivePort() (it must stay
// self-contained inside the skill directory); test-start-init.mjs asserts that
// both copies agree.

import { createHash } from 'node:crypto';

export const PORT_RANGE_MIN = 4300;
export const PORT_RANGE_MAX = 4999;

// Stable port in 4300-4999 derived from the project id: the same project gets
// the same URL on every launch without any registry or random choice.
export function derivePort(projectId) {
  const digest = createHash('sha256').update(String(projectId).trim().toLowerCase()).digest();
  return PORT_RANGE_MIN + (digest.readUInt32BE(0) % (PORT_RANGE_MAX - PORT_RANGE_MIN + 1));
}

// Next candidate inside the derived range (wraps), used when a derived port is taken.
export function nextPortInRange(port) {
  return port >= PORT_RANGE_MAX || port < PORT_RANGE_MIN ? PORT_RANGE_MIN : port + 1;
}

export function parsePortNumber(value, label, { allowZero = false } = {}) {
  const text = String(value).trim();
  const port = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535 || port < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be an integer port between ${allowZero ? 0 : 1} and 65535 (got '${text}').`);
  }
  return port;
}
