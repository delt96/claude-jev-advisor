import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, readConfig, writeConfig } from '../src/config.js';
import { writeState } from '../src/context/files.js';
import { install } from '../src/install.js';
import { statusLines } from '../src/status.js';

const NOW = new Date(2026, 9, 2, 21, 0, 0);
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-sctx-'));

function installedHome(display: 'mod' | 'statusline' | 'message' = 'mod'): string {
  const home = tempHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jev-advisor-'));
  const distDir = path.join(root, 'claude-jev-advisor', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'context-hook.js'), '');
  install({ home, features: ['context'], distDir, platform: 'win32', now: NOW, delimiter: ';', display });
  return home;
}

test('context is listed when it is not installed', () => {
  assert.ok(statusLines(tempHome(), {}).includes('context: not installed (on)'));
});

test('an installed context shows its display, key, thresholds and no broken line', () => {
  const home = installedHome();
  const lines = statusLines(home, {});
  assert.ok(lines.includes('context: installed, on'));
  assert.ok(lines.includes('  display: mod'));
  assert.ok(lines.includes('  key: missing'));
  assert.ok(lines.includes('  thresholds: judge from 100k, /compact from 200k, red at 20% left'));
  assert.equal(lines.some((l) => l.includes('broken')), false);
  assert.ok(statusLines(home, { TYPESAFE_API_KEY: 'ts-x' }).includes('  key: set'));
  assert.equal(statusLines(home, { TYPESAFE_API_KEY: 'ts-x' }).join('\n').includes('ts-x'), false);
});

test('a display recorded in the config but not set up in settings.json is reported', () => {
  const home = installedHome('message');
  writeConfig(home, { ...readConfig(home), display: 'mod' });
  assert.ok(statusLines(home, {}).includes('  display: mod (not set up in settings.json - run "claude-jev-advisor install context --display mod")'));
  const statusline = installedHome('statusline');
  assert.ok(statusLines(statusline, {}).includes('  display: statusline'));
});

test('the newest judgment is shown with its time', () => {
  const home = installedHome();
  writeState(home, { sessionId: 'old', at: Date.UTC(2026, 9, 2, 10, 0, 0), size: 150000, judgment: { phase: 'working', clear: false } });
  const oldFile = path.join(home, '.claude', 'claude-jev-advisor', 'state', 'old.json');
  fs.utimesSync(oldFile, new Date(2026, 9, 2, 10, 0, 0), new Date(2026, 9, 2, 10, 0, 0));
  writeState(home, { sessionId: 'new', at: Date.UTC(2026, 9, 2, 12, 0, 0), size: 312000, judgment: { phase: 'unit_done', clear: true } });
  assert.ok(statusLines(home, {}).includes('  last judgment: 2026-10-02T12:00:00.000Z 🟡 312k 새롭게 시작하는 건 어떠세요? /clear'));
});

test('switched off, context still shows its settings', () => {
  const home = installedHome();
  writeConfig(home, { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, enabled: false } });
  assert.ok(statusLines(home, {}).includes('context: installed, off'));
});
