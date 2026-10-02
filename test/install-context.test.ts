import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, setEnabled, uninstall } from '../src/install.js';
import { readConfig } from '../src/config.js';
import { backupsDir, dataDir, settingsPath, statusLineBeforePath } from '../src/paths.js';

const DIST = 'C:/n/@delt/claude-jev-advisor/dist';
const MOD = 'C:/n/@delt/claude-jev-advisor/mod';
const NOW = new Date(2026, 9, 2, 21, 0, 0);
const STOP = 'node "C:/n/@delt/claude-jev-advisor/dist/context-hook.js" stop';
const END = 'node "C:/n/@delt/claude-jev-advisor/dist/context-hook.js" session-end';
const STATUS = 'node "C:/n/@delt/claude-jev-advisor/dist/statusline.js"';
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-ictx-'));
const opts = (home: string, extra: Partial<Parameters<typeof install>[0]> = {}) => ({
  home,
  features: ['context' as const],
  distDir: DIST,
  platform: 'win32' as const,
  now: NOW,
  delimiter: ';',
  ...extra,
});
const forward = (p: string) => p.replace(/\\/g, '/');
const readSettings = (home: string) => JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
function writeSettings(home: string, value: unknown) {
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify(value, null, 2));
}

test('install context registers Stop and SessionEnd and the mod display', () => {
  const home = tempHome();
  const r = install(opts(home));
  assert.deepEqual(r.installed, ['context']);
  assert.equal(r.display, 'mod');
  assert.deepEqual(readSettings(home), {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: STOP, timeout: 15 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: END, timeout: 15 }] }],
    },
    env: { CLAUDE_CODE_PLUGIN_DIRS: MOD },
    pluginConfigs: { 'jev-advisor': { options: { dataDir: forward(dataDir(home)) } } },
  });
  assert.equal(readConfig(home).context.enabled, true);
});

test('the user plugin folders, env and plugin options stay, and uninstall takes out only ours', () => {
  const home = tempHome();
  const original = { env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:/my-mods', OTHER: '1' }, pluginConfigs: { mine: { options: { a: 1 } } } };
  writeSettings(home, original);
  install(opts(home));
  const s = readSettings(home);
  assert.equal(s.env.CLAUDE_CODE_PLUGIN_DIRS, `D:/my-mods;${MOD}`);
  assert.equal(s.env.OTHER, '1');
  assert.deepEqual(Object.keys(s.pluginConfigs), ['mine', 'jev-advisor']);
  const u = uninstall({ home, features: ['context'], now: NOW, delimiter: ';' });
  assert.deepEqual(u.removed, ['context']);
  assert.deepEqual(readSettings(home), original);
});

test('installing context twice changes nothing the second time', () => {
  const home = tempHome();
  install(opts(home));
  const first = fs.readFileSync(settingsPath(home), 'utf8');
  assert.equal(install(opts(home)).backup, null);
  assert.equal(fs.readFileSync(settingsPath(home), 'utf8'), first);
  assert.equal(fs.existsSync(backupsDir(home)), false);
});

test('switching to the status line keeps the user line to run first, and switching back restores it', () => {
  const home = tempHome();
  const userLine = { type: 'command', command: 'bash ~/my-status.sh', padding: 1 };
  writeSettings(home, { statusLine: userLine });
  const r = install(opts(home, { display: 'statusline' }));
  assert.equal(r.display, 'statusline');
  let s = readSettings(home);
  assert.deepEqual(s.statusLine, { type: 'command', command: STATUS, refreshInterval: 3 });
  assert.equal(s.env, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(statusLineBeforePath(home), 'utf8')), userLine);
  install(opts(home, { display: 'mod' }));
  s = readSettings(home);
  assert.deepEqual(s.statusLine, userLine);
  assert.equal(s.env.CLAUDE_CODE_PLUGIN_DIRS, MOD);
  assert.equal(fs.existsSync(statusLineBeforePath(home)), false);
});

test('uninstall puts the user status line back', () => {
  const home = tempHome();
  const userLine = { type: 'command', command: 'mine' };
  writeSettings(home, { statusLine: userLine });
  install(opts(home, { display: 'statusline' }));
  uninstall({ home, features: ['context'], now: NOW, delimiter: ';' });
  assert.deepEqual(readSettings(home), { statusLine: userLine });
});

test('display message registers only the hooks', () => {
  const home = tempHome();
  assert.equal(install(opts(home, { display: 'message' })).display, 'message');
  const s = readSettings(home);
  assert.deepEqual(Object.keys(s), ['hooks']);
  assert.equal(readConfig(home).display, 'message');
});

test('installing rm alone records the display but does not touch the display settings', () => {
  const home = tempHome();
  const r = install(opts(home, { features: ['rm'], display: 'statusline' }));
  assert.equal(r.display, null);
  assert.deepEqual(Object.keys(readSettings(home)), ['hooks']);
  assert.equal(readConfig(home).display, 'statusline');
});

test('on and off switch context without touching rm or settings.json', () => {
  const home = tempHome();
  setEnabled(home, ['context'], false);
  assert.equal(readConfig(home).context.enabled, false);
  assert.equal(readConfig(home).rm.enabled, true);
  setEnabled(home, ['context'], true);
  assert.equal(readConfig(home).context.enabled, true);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test('install switches context back on', () => {
  const home = tempHome();
  setEnabled(home, ['context'], false);
  install(opts(home));
  assert.equal(readConfig(home).context.enabled, true);
});

test('a settings.json that cannot be saved does not lose the user status line', { skip: process.platform !== 'win32' && 'renaming over a read-only file fails only on Windows' }, () => {
  const home = tempHome();
  const userLine = { type: 'command', command: 'bash ~/my-status.sh' };
  writeSettings(home, { statusLine: userLine });
  install(opts(home, { display: 'statusline' }));
  fs.chmodSync(settingsPath(home), 0o444);
  try {
    assert.throws(() => install(opts(home, { display: 'mod' })));
  } finally {
    fs.chmodSync(settingsPath(home), 0o666);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(statusLineBeforePath(home), 'utf8')), userLine);
  assert.match(readSettings(home).statusLine.command, /statusline\.js/);
  install(opts(home, { display: 'mod' }));
  assert.deepEqual(readSettings(home).statusLine, userLine);
  assert.equal(fs.existsSync(statusLineBeforePath(home)), false);
});
