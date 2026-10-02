import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/run.js';
import { readConfig } from '../src/config.js';
import { settingsPath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-cctx-'));

function cli(argv: string[], home = tempHome()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { home, distDir: 'C:/n/@delt/claude-jev-advisor/dist', platform: 'win32', now: () => new Date(2026, 9, 2, 21, 0, 0), out: (l) => out.push(l), err: (l) => err.push(l) };
  const code = runCli(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n'), home };
}

test('install with no helpers installs rm and context with the mod display', () => {
  const r = cli(['install']);
  assert.equal(r.code, 0);
  assert.match(r.out, /installed rm/);
  assert.match(r.out, /installed context/);
  assert.match(r.out, /display: mod/);
  const s = JSON.parse(fs.readFileSync(settingsPath(r.home), 'utf8'));
  assert.ok(s.hooks.Stop && s.hooks.SessionEnd && s.hooks.PreToolUse);
});

test('install context --display statusline sets our status line', () => {
  const r = cli(['install', 'context', '--display', 'statusline']);
  assert.equal(r.code, 0);
  assert.match(r.out, /display: statusline/);
  const s = JSON.parse(fs.readFileSync(settingsPath(r.home), 'utf8'));
  assert.match(s.statusLine.command, /statusline\.js/);
});

test('off context leaves rm on', () => {
  const home = tempHome();
  assert.equal(cli(['off', 'context'], home).code, 0);
  assert.equal(readConfig(home).context.enabled, false);
  assert.equal(readConfig(home).rm.enabled, true);
});

test('the usage lists context', () => {
  assert.match(cli(['help']).out, /install \[rm\] \[context\]/);
});
