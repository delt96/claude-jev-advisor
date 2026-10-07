import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, type CliIo } from '../src/cli/run.js';
import { readConfig } from '../src/config.js';
import { settingsPath } from '../src/paths.js';

const REPO = path.resolve(import.meta.dirname, '..');
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-cli-'));

async function cli(argv: string[], home = tempHome(), platform: NodeJS.Platform = 'win32') {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { home, distDir: 'C:/n/@delt/claude-jev-advisor/dist', platform, now: () => new Date(2026, 9, 2, 9, 5, 7), out: (l) => out.push(l), err: (l) => err.push(l), env: {} };
  const code = await runCli(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n'), home };
}

test('install with no features installs everything and says when it applies', async () => {
  const r = await cli(['install']);
  assert.equal(r.code, 0);
  assert.match(r.out, /installed rm/);
  assert.match(r.out, /apply right away, also in open Claude Code sessions/);
  assert.ok(fs.existsSync(settingsPath(r.home)));
});

test('install passes options through to the config', async () => {
  const r = await cli(['install', 'rm', '--lang', 'en', '--key-file', 'C:/workspace/jev-key.env', '--display', 'message']);
  assert.equal(r.code, 0);
  assert.equal(readConfig(r.home).keyFile, 'C:/workspace/jev-key.env');
  assert.equal(readConfig(r.home).display, 'message');
});

test('bad arguments are usage errors with exit code 2', async () => {
  assert.equal((await cli(['install', 'nope'])).code, 2);
  assert.equal((await cli(['install', '--lang', 'fr'])).code, 2);
  assert.equal((await cli(['install', '--display', 'popup'])).code, 2);
  assert.equal((await cli(['install', '--lang'])).code, 2);
  assert.equal((await cli(['install', '--color', 'red'])).code, 2);
  assert.equal((await cli(['on', '--lang', 'ko'])).code, 2);
  assert.equal((await cli(['fly'])).code, 2);
});

test('on and off flip the switch', async () => {
  const home = tempHome();
  assert.equal((await cli(['off', 'rm'], home)).code, 0);
  assert.equal(readConfig(home).rm.enabled, false);
  assert.equal((await cli(['on'], home)).code, 0);
  assert.equal(readConfig(home).rm.enabled, true);
});

test('uninstall reports when nothing was installed', async () => {
  const r = await cli(['uninstall']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing to remove/);
});

test('a broken settings.json is a failure with exit code 1, not a crash', async () => {
  const home = tempHome();
  fs.mkdirSync(path.dirname(settingsPath(home)), { recursive: true });
  fs.writeFileSync(settingsPath(home), '{');
  const r = await cli(['install'], home);
  assert.equal(r.code, 1);
  assert.match(r.err, /^claude-jev-advisor: /);
});

test('help prints the usage', async () => {
  const r = await cli([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: claude-jev-advisor/);
});

test('the bin entry runs status against HOME', async () => {
  const home = tempHome();
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'status'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /rm: not installed \(on\)/);
  assert.match(r.stdout, new RegExp(home.replace(/\\/g, '\\\\')));
});

test('a relative --key-file is stored as an absolute path', async () => {
  const r = await cli(['install', 'rm', '--key-file', 'jev-key.env']);
  assert.equal(readConfig(r.home).keyFile, path.resolve('jev-key.env'));
});

test('install prints the shortcut it bound, and uninstall says it took it out', async () => {
  const r = await cli(['install', 'context']);
  assert.equal(r.code, 0);
  assert.match(r.out, /shortcut: ctrl\+x ctrl\+f presses the advice button/);
  assert.ok(r.out.includes('The bottom-row display and the advice button start with the next new session; sessions that already show the bottom-row display pick up an upgrade by themselves.'));
  const u = await cli(['uninstall', 'context'], r.home);
  assert.match(u.out, /removed the ctrl\+x ctrl\+f shortcut from keybindings\.json/);
});

test('switching display reports the shortcut removal and its backup', async () => {
  const home = tempHome();
  await cli(['install', 'context'], home);
  const r = await cli(['install', 'context', '--display', 'statusline'], home);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  assert.match(r.out, /removed the ctrl\+x ctrl\+f shortcut from keybindings\.json\nbackup: .*keybindings/);
});
