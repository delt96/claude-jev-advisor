import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, writeConfig, type Config } from '../src/config.js';
import { writeState } from '../src/context/files.js';
import { runBeforeCommand, runStatusLine } from '../src/display/statusline-run.js';
import { statusLineBeforePath } from '../src/paths.js';

const REPO = path.resolve(import.meta.dirname, '..');
const input = (sessionId: string, tokens: number) => JSON.stringify({ session_id: sessionId, context_window: { total_input_tokens: tokens, context_window_size: 1000000 } });
const none = () => '';

function setup(change: (c: Config) => Config = (c) => c): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-sl-'));
  writeConfig(home, change({ ...DEFAULT_CONFIG, display: 'statusline' }));
  return home;
}

test('the line shows the size and the saved judgment, and drops a judgment made before /compact', () => {
  const home = setup();
  assert.equal(runStatusLine(input('s1', 52000), { home, runBefore: none }), '52k');
  writeState(home, { sessionId: 's1', at: 1, size: 312000, judgment: { phase: 'unit_done', clear: true } });
  assert.equal(runStatusLine(input('s1', 312400), { home, runBefore: none }), '🟡 312k 새롭게 시작하는 건 어떠세요? /clear');
  assert.equal(runStatusLine(input('s1', 80000), { home, runBefore: none }), '80k');
});

test('a user status line runs first with the same input and ours follows it', () => {
  const home = setup();
  fs.writeFileSync(statusLineBeforePath(home), JSON.stringify({ type: 'command', command: 'my-status', padding: 1 }));
  const seen: string[] = [];
  const out = runStatusLine(input('s1', 52000), { home, runBefore: (command, raw) => { seen.push(command, raw); return 'main · opus\n'; } });
  assert.equal(out, 'main · opus 52k');
  assert.deepEqual(seen, ['my-status', input('s1', 52000)]);
});

test('with another display, or switched off, only the user line is printed', () => {
  for (const change of [(c: Config): Config => ({ ...c, display: 'mod' }), (c: Config): Config => ({ ...c, context: { ...c.context, enabled: false } })]) {
    const home = setup(change);
    fs.writeFileSync(statusLineBeforePath(home), JSON.stringify({ type: 'command', command: 'my-status' }));
    assert.equal(runStatusLine(input('s1', 312000), { home, runBefore: () => 'mine' }), 'mine');
  }
});

test('before the first reply and on broken input nothing of ours is printed', () => {
  const home = setup();
  assert.equal(runStatusLine(input('s1', 0), { home, runBefore: none }), '');
  assert.equal(runStatusLine('not json', { home, runBefore: none }), '');
});

test('the previous command runs through the shell with the input on stdin', () => {
  assert.equal(runBeforeCommand(`node -e "process.stdout.write(String(require('fs').readFileSync(0, 'utf8').length))"`, 'abcd'), '4');
  assert.equal(runBeforeCommand('a-command-that-does-not-exist-cja', 'x'), '');
});

test('the entry prints the line for HOME and exits 0 on broken input', () => {
  const home = setup();
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const ok = spawnSync(process.execPath, ['--import', 'tsx', 'src/display/statusline.ts'], { cwd: REPO, input: input('s1', 52000), encoding: 'utf8', env });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '52k');
  const bad = spawnSync(process.execPath, ['--import', 'tsx', 'src/display/statusline.ts'], { cwd: REPO, input: '{', encoding: 'utf8', env });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});
