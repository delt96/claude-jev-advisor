import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyStatusLineDisplay, forgetStatusLineBefore, isOurStatusLine, readStatusLineBefore, withModDisplay, withoutModDisplay } from '../src/display/settings.js';
import { statusLineBeforePath } from '../src/paths.js';
import type { Settings } from '../src/settings.js';

const MOD = 'C:/n/@delt/claude-jev-advisor/mod';
const OURS = 'node "C:/n/@delt/claude-jev-advisor/dist/statusline.js"';
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-ds-'));

test('the mod display appends our folder and our options, keeping the user ones', () => {
  const before: Settings = { model: 'opus', env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:/my-mods', OTHER: '1' }, pluginConfigs: { mine: { options: { a: 1 } } } };
  const after = withModDisplay(before, 'C:\\n\\@delt\\claude-jev-advisor\\mod', 'C:\\Users\\me\\.claude\\claude-jev-advisor', ';');
  assert.deepEqual(after, {
    model: 'opus',
    env: { CLAUDE_CODE_PLUGIN_DIRS: `D:/my-mods;${MOD}`, OTHER: '1' },
    pluginConfigs: { mine: { options: { a: 1 } }, 'jev-advisor': { options: { dataDir: 'C:/Users/me/.claude/claude-jev-advisor' } } },
  });
  assert.deepEqual(Object.keys(after), ['model', 'env', 'pluginConfigs']);
  assert.deepEqual(withModDisplay(after, MOD, 'C:/Users/me/.claude/claude-jev-advisor', ';'), after);
});

test('removing the mod display takes out only ours, and drops env or pluginConfigs only when we emptied them', () => {
  const user: Settings = { env: { CLAUDE_CODE_PLUGIN_DIRS: 'D:/my-mods', OTHER: '1' }, pluginConfigs: { mine: { options: {} } }, theme: 'dark' };
  assert.deepEqual(withoutModDisplay(withModDisplay(user, MOD, 'C:/d', ';'), ';'), user);
  assert.deepEqual(withoutModDisplay(withModDisplay({ theme: 'dark' }, MOD, 'C:/d', ';'), ';'), { theme: 'dark' });
  const keyOrder = withoutModDisplay({ env: { CLAUDE_CODE_PLUGIN_DIRS: `${MOD};D:/my-mods`, A: '1' }, theme: 'dark' }, ';');
  assert.deepEqual(Object.keys(keyOrder.env as object), ['CLAUDE_CODE_PLUGIN_DIRS', 'A']);
  assert.equal((keyOrder.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS, 'D:/my-mods');
});

test('removing with nothing of ours returns the same object, even with empty env and pluginConfigs', () => {
  const settings: Settings = { env: {}, pluginConfigs: {}, theme: 'dark' };
  assert.equal(withoutModDisplay(settings, ';'), settings);
});

test('the status line display saves the user line, taking it out restores it, and the saved copy goes only when asked', () => {
  const home = tempHome();
  const userLine = { type: 'command', command: 'bash ~/my-status.sh', padding: 1 };
  const on = applyStatusLineDisplay({ statusLine: userLine, theme: 'dark' }, home, OURS);
  assert.deepEqual(on, { statusLine: { type: 'command', command: OURS, refreshInterval: 3 }, theme: 'dark' });
  assert.ok(isOurStatusLine(on.statusLine));
  assert.deepEqual(readStatusLineBefore(home), userLine);
  assert.deepEqual(applyStatusLineDisplay(on, home, OURS), on);
  assert.deepEqual(readStatusLineBefore(home), userLine);
  const off = applyStatusLineDisplay(on, home, null);
  assert.deepEqual(off, { statusLine: userLine, theme: 'dark' });
  assert.deepEqual(readStatusLineBefore(home), userLine);
  forgetStatusLineBefore(home, on);
  assert.deepEqual(readStatusLineBefore(home), userLine);
  forgetStatusLineBefore(home, off);
  assert.equal(fs.existsSync(statusLineBeforePath(home)), false);
});

test('without a user line, taking ours out removes the key; a user line alone is left alone', () => {
  const home = tempHome();
  const on = applyStatusLineDisplay({ theme: 'dark' }, home, OURS);
  assert.equal(readStatusLineBefore(home), null);
  assert.deepEqual(applyStatusLineDisplay(on, home, null), { theme: 'dark' });
  const user: Settings = { statusLine: { type: 'command', command: 'mine' } };
  assert.equal(applyStatusLineDisplay(user, home, null), user);
});
