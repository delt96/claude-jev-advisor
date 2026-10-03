import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLog, logFile, readState, removeState, statePath, writeState } from '../src/context/files.js';
import { logDir, stateDir, statusLineBeforePath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-files-'));

test('the new paths live in the data folder', () => {
  const home = path.join('C:', 'Users', 'me');
  const data = path.join(home, '.claude', 'claude-jev-advisor');
  assert.equal(stateDir(home), path.join(data, 'state'));
  assert.equal(logDir(home), path.join(data, 'log'));
  assert.equal(statusLineBeforePath(home), path.join(data, 'statusline-before.json'));
});

test('a state is written, read back and removed', () => {
  const home = tempHome();
  const state = { sessionId: 'a1b2-c3', at: 1700000000000, size: 312000, judgment: { phase: 'unit_done' as const, clear: true } };
  writeState(home, state);
  assert.deepEqual(readState(home, 'a1b2-c3'), state);
  assert.equal(fs.existsSync(`${statePath(home, 'a1b2-c3')}.tmp`), false);
  removeState(home, 'a1b2-c3');
  assert.equal(readState(home, 'a1b2-c3'), null);
  removeState(home, 'a1b2-c3');
});

test('a session id that could leave the state folder is refused', () => {
  const home = tempHome();
  assert.equal(statePath(home, '../escape'), null);
  assert.equal(statePath(home, 'a/b'), null);
  writeState(home, { sessionId: '../escape', at: 1, size: 1, judgment: null });
  assert.equal(fs.existsSync(stateDir(home)), false);
  assert.equal(readState(home, '../escape'), null);
});

test('a broken state file reads as nothing', () => {
  const home = tempHome();
  fs.mkdirSync(stateDir(home), { recursive: true });
  fs.writeFileSync(path.join(stateDir(home), 's1.json'), '{"sessionId":');
  assert.equal(readState(home, 's1'), null);
});

test('log records go to a monthly file, one JSON line each, with the time', () => {
  const home = tempHome();
  const now = new Date(2026, 9, 2, 21, 5, 0);
  assert.equal(logFile(home, now), path.join(logDir(home), '2026-10.jsonl'));
  appendLog(home, now, { event: 'stop', size: 1 });
  appendLog(home, now, { event: 'session_end' });
  const lines = fs.readFileSync(logFile(home, now), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { at: now.toISOString(), event: 'stop', size: 1 },
    { at: now.toISOString(), event: 'session_end' },
  ]);
});

test('a state that cannot be moved into place throws and leaves no temp file behind', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(stateDir(home), 's1.json'), { recursive: true });
  assert.throws(() => writeState(home, { sessionId: 's1', at: 1, size: 1, judgment: null }));
  assert.deepEqual(fs.readdirSync(stateDir(home)).filter((name) => name.endsWith('.tmp')), []);
});

test('appendLog replaces each secret, also in its JSON-escaped form, and ignores empty ones', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-files-secret-'));
  const now = new Date(2026, 9, 3, 10, 0, 0);
  appendLog(home, now, { note: 'key ts-abc and ts-"q"' }, ['ts-abc', 'ts-"q"', null, '']);
  const line = fs.readFileSync(logFile(home, now), 'utf8');
  assert.equal(line.includes('ts-abc'), false);
  assert.equal(line.includes('ts-\\"q\\"'), false);
  assert.equal(JSON.parse(line).note, 'key [redacted] and [redacted]');
});
