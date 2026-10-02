import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, setEnabled, uninstall } from '../src/install.js';
import { readConfig } from '../src/config.js';
import { backupsDir, settingsPath } from '../src/paths.js';

const DIST = 'C:/n/@delt/claude-jev-advisor/dist';
const OUR_COMMAND = 'node "C:/n/@delt/claude-jev-advisor/dist/rm-hook.js"';
const LEGACY_COMMAND = 'node "C:/Users/me/.claude/hooks/rm-guard/rm-guard.mjs"';
const NOW = new Date(2026, 9, 2, 9, 5, 7);
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-install-'));

function writeSettings(home: string, value: unknown) {
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const readSettings = (home: string) => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
const opts = (home: string, extra: Partial<Parameters<typeof install>[0]> = {}) => ({ home, features: ['rm' as const], distDir: DIST, platform: 'win32' as const, now: NOW, ...extra });

test('install on a machine without ~/.claude creates settings.json with the rm hook', () => {
  const home = tempHome();
  const r = install(opts(home));
  assert.deepEqual(r.installed, ['rm']);
  assert.equal(r.backup, null);
  assert.deepEqual(readSettings(home), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OUR_COMMAND, timeout: 15 }] }] } });
  assert.equal(readConfig(home).rm.enabled, true);
});

test('install replaces the legacy rm-guard, keeps everything else and backs up first', () => {
  const home = tempHome();
  const original = {
    permissions: { defaultMode: 'auto' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY_COMMAND, timeout: 10 }, { type: 'command', command: 'node mine.js' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }],
    },
  };
  writeSettings(home, original);
  const r = install(opts(home));
  assert.equal(r.replacedLegacyRmGuard, true);
  assert.deepEqual(readSettings(home), {
    permissions: { defaultMode: 'auto' },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node mine.js' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: OUR_COMMAND, timeout: 15 }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }],
    },
  });
  assert.equal(r.backup, path.join(backupsDir(home), 'settings.json.2026-10-02-090507-before-claude-jev-advisor'));
  assert.deepEqual(JSON.parse(fs.readFileSync(r.backup!, 'utf8')), original);
});

test('installing twice changes nothing the second time', () => {
  const home = tempHome();
  install(opts(home));
  const first = fs.readFileSync(settingsPath(home), 'utf8');
  const r = install(opts(home));
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), first);
  assert.equal(fs.existsSync(backupsDir(home)), false);
});

test('installing from a new location replaces the old entry', () => {
  const home = tempHome();
  install(opts(home, { distDir: 'C:/workspace/claude-jev-advisor/dist' }));
  install(opts(home));
  assert.deepEqual(readSettings(home).hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: OUR_COMMAND, timeout: 15 }] }]);
});

test('rm is skipped outside Windows and settings are left alone', () => {
  const home = tempHome();
  const r = install(opts(home, { platform: 'linux' }));
  assert.deepEqual(r.installed, []);
  assert.deepEqual(r.skipped, [{ feature: 'rm', reason: 'rm works on win32 only' }]);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test('install stops on settings.json that is not JSON and touches nothing', () => {
  const home = tempHome();
  writeSettings(home, '{"hooks": ');
  assert.throws(() => install(opts(home)));
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), '{"hooks": ');
  assert.equal(fs.existsSync(backupsDir(home)), false);
});

test('install records lang, key file and display in the config', () => {
  const home = tempHome();
  install(opts(home, { lang: 'en', keyFile: 'C:/workspace/jev-key.env', display: 'statusline' }));
  const config = readConfig(home);
  assert.equal(config.lang, 'en');
  assert.equal(config.keyFile, 'C:/workspace/jev-key.env');
  assert.equal(config.display, 'statusline');
});

test('install switches a feature back on', () => {
  const home = tempHome();
  setEnabled(home, ['rm'], false);
  install(opts(home));
  assert.equal(readConfig(home).rm.enabled, true);
});

test('uninstall removes only this package and reports what it removed', () => {
  const home = tempHome();
  const original = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node mine.js' }] }] } };
  writeSettings(home, original);
  const installResult = install(opts(home));
  const r = uninstall({ home, features: ['rm'], now: NOW });
  assert.deepEqual(r.removed, ['rm']);
  assert.notEqual(r.backup, null);
  assert.deepEqual(readSettings(home), original);
  assert.notEqual(installResult.backup, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(installResult.backup!, 'utf8')), original);
  assert.notEqual(r.backup, installResult.backup);
  const again = uninstall({ home, features: ['rm'], now: NOW });
  assert.deepEqual(again.removed, []);
  assert.equal(again.backup, null);
});

test('setEnabled flips the switch without touching settings.json', () => {
  const home = tempHome();
  setEnabled(home, ['rm'], false);
  assert.equal(readConfig(home).rm.enabled, false);
  setEnabled(home, ['rm'], true);
  assert.equal(readConfig(home).rm.enabled, true);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});
