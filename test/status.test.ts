import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { statusLines } from '../src/status.js';
import { install, setEnabled } from '../src/install.js';
import { settingsPath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-status-'));
const NOW = new Date(2026, 9, 2, 9, 5, 7);

test('nothing installed', () => {
  const lines = statusLines(tempHome());
  assert.ok(lines.includes('rm: not installed (on)'));
});

test('installed with the hook file present, and switched off', () => {
  const home = tempHome();
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jev-advisor-'));
  const distDir = path.join(dist, 'claude-jev-advisor', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'rm-hook.js'), '');
  install({ home, features: ['rm'], distDir, platform: 'win32', now: NOW });
  assert.ok(statusLines(home).includes('rm: installed, on'));
  assert.equal(statusLines(home).some((l) => l.includes('broken')), false);
  assert.ok(statusLines(home, {}).includes('  jev: on, lifts the ask from 0.8 (no key - every real file asks)'));
  assert.ok(statusLines(home, { TYPESAFE_API_KEY: 'ts-x' }).includes('  jev: on, lifts the ask from 0.8'));
  setEnabled(home, ['rm'], false);
  assert.ok(statusLines(home).includes('rm: installed, off'));
});

test('an rm hook registered for Bash only says how to cover PowerShell', () => {
  const home = tempHome();
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-jev-advisor-'));
  const distDir = path.join(dist, 'claude-jev-advisor', 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'rm-hook.js'), '');
  const command = `node "${path.join(distDir, 'rm-hook.js').replace(/\\/g, '/')}"`;
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] } }));
  const warning = '  Bash only: run "claude-jev-advisor install rm" to cover PowerShell';
  assert.ok(statusLines(home).includes(warning));
  install({ home, features: ['rm'], distDir, platform: 'win32', now: NOW });
  assert.equal(statusLines(home).includes(warning), false);
});

test('a hook pointing to a missing file is reported as broken', () => {
  const home = tempHome();
  install({ home, features: ['rm'], distDir: 'C:/gone/claude-jev-advisor/dist', platform: 'win32', now: NOW });
  assert.ok(statusLines(home).some((l) => l.startsWith('  broken: PreToolUse hook points to a missing file')));
});

test('a leftover legacy rm-guard entry is reported', () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "C:/Users/me/.claude/hooks/rm-guard/rm-guard.mjs"' }] }] } }));
  assert.ok(statusLines(home).some((l) => l.startsWith('legacy rm-guard hook')));
});

test('unreadable settings.json is reported instead of thrown', () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), '{');
  assert.ok(statusLines(home).some((l) => l.startsWith('settings.json could not be read')));
});
