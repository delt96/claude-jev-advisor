import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, writeConfig, type Config } from '../src/config.js';
import { writeState } from '../src/context/files.js';
import { findGitBash, runBeforeCommand, runStatusLine, statusLineShell, type Shell } from '../src/display/statusline-run.js';
import { statusLineBeforePath } from '../src/paths.js';

const REPO = path.resolve(import.meta.dirname, '..');
const input = (sessionId: string, tokens: number) => JSON.stringify({ session_id: sessionId, context_window: { total_input_tokens: tokens, context_window_size: 1000000 } });
const none = async () => '';
const NODE_SHELL: Shell = { file: process.execPath, args: ['-e'] };

function setup(change: (c: Config) => Config = (c) => c): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-sl-'));
  writeConfig(home, change({ ...DEFAULT_CONFIG, display: 'statusline' }));
  return home;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('the line shows the size and the saved judgment, and drops a judgment made before /compact', async () => {
  const home = setup();
  assert.equal(await runStatusLine(input('s1', 52000), { home, runBefore: none }), '52k');
  writeState(home, { sessionId: 's1', at: 1, size: 312000, judgment: { phase: 'unit_done', clear: true } });
  assert.equal(await runStatusLine(input('s1', 312400), { home, runBefore: none }), '🟡 312k 새롭게 시작하는 건 어떠세요? /clear');
  assert.equal(await runStatusLine(input('s1', 80000), { home, runBefore: none }), '80k');
});

test('a user status line runs first with the same input and ours follows it', async () => {
  const home = setup();
  fs.writeFileSync(statusLineBeforePath(home), JSON.stringify({ type: 'command', command: 'my-status', padding: 1 }));
  const seen: string[] = [];
  const out = await runStatusLine(input('s1', 52000), {
    home,
    runBefore: async (command, raw) => {
      seen.push(command, raw);
      return 'main · opus\n';
    },
  });
  assert.equal(out, 'main · opus 52k');
  assert.deepEqual(seen, ['my-status', input('s1', 52000)]);
});

test('with another display, or switched off, only the user line is printed', async () => {
  for (const change of [(c: Config): Config => ({ ...c, display: 'mod' }), (c: Config): Config => ({ ...c, context: { ...c.context, enabled: false } })]) {
    const home = setup(change);
    fs.writeFileSync(statusLineBeforePath(home), JSON.stringify({ type: 'command', command: 'my-status' }));
    assert.equal(await runStatusLine(input('s1', 312000), { home, runBefore: async () => 'mine' }), 'mine');
  }
});

test('before the first reply and on broken input nothing of ours is printed', async () => {
  const home = setup();
  assert.equal(await runStatusLine(input('s1', 0), { home, runBefore: none }), '');
  assert.equal(await runStatusLine('not json', { home, runBefore: none }), '');
});

test('on Windows the user command runs in Git Bash when it is found, otherwise in PowerShell; elsewhere in sh', () => {
  const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'D:\\tools\\bash.exe']);
  const exists = (file: string) => files.has(file);
  assert.deepEqual(statusLineShell('win32', { PATH: 'C:\\Windows;C:\\Program Files\\Git\\cmd' }, exists), { file: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['-c'] });
  assert.deepEqual(statusLineShell('win32', { PATH: 'C:\\Windows' }, () => false), { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] });
  assert.deepEqual(statusLineShell('linux', {}, () => false), { file: '/bin/sh', args: ['-c'] });
  assert.equal(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe', PATH: '' }, exists), 'D:\\tools\\bash.exe');
  assert.equal(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\gone\\bash.exe', Path: 'C:\\Program Files\\Git\\cmd' }, exists), 'C:\\Program Files\\Git\\bin\\bash.exe');
  const mingw = new Set(['E:\\Git\\mingw64\\bin\\git.exe', 'E:\\Git\\bin\\bash.exe']);
  assert.equal(findGitBash({ PATH: 'E:\\Git\\mingw64\\bin' }, (file) => mingw.has(file)), 'E:\\Git\\bin\\bash.exe');
  assert.equal(findGitBash({ PATH: 'C:\\Windows' }, () => false), null);
});

test('the previous command gets the input on stdin, and a failing command gives nothing', async () => {
  assert.equal(await runBeforeCommand('process.stdin.pipe(process.stdout)', 'abcd', NODE_SHELL), 'abcd');
  assert.equal(await runBeforeCommand('process.exit(3)', 'x', NODE_SHELL), '');
  assert.equal(await runBeforeCommand('x', 'x', { file: path.join(os.tmpdir(), 'no-such-shell-cja.exe'), args: [] }), '');
});

test('the default shell of this machine runs a plain command', async () => {
  assert.equal((await runBeforeCommand('echo hi', '')).trim(), 'hi');
});

test('a command that overruns gives nothing in time and its child processes are ended too', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-sl-kill-')), 'child.pid');
  const script = [
    "const { spawn } = require('child_process');",
    // On Windows a plain child dies with its Node parent (libuv job object); a detached one does not, like the children of Git Bash.
    `const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: process.platform === 'win32', windowsHide: true });`,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
    'setTimeout(() => {}, 30000);',
  ].join('\n');
  const started = Date.now();
  assert.equal(await runBeforeCommand(script, '', NODE_SHELL, 800), '');
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  const child = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && alive(child); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(child), false);
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
