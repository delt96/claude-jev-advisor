import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runRmHook, type RmHookDeps } from '../src/rm/run.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';

const REPO = path.resolve(import.meta.dirname, '..');
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rm-'));
const bash = (command: string, cwd = 'C:\\workspace\\proj') => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });

function deps(home: string): RmHookDeps {
  return { home, env: { TEMP: 'C:\\Temp' }, tmpdir: 'C:\\Temp', cwd: 'C:\\workspace\\proj', probe: { exists: () => true, isIgnored: () => false } };
}

test('a real file asks', () => {
  const out = runRmHook(bash('rm src/a.ts'), deps(tempHome()));
  assert.equal(JSON.parse(out!).hookSpecificOutput.permissionDecision, 'ask');
});

test('a temp file and other tools give no output', () => {
  const home = tempHome();
  assert.equal(runRmHook(bash('rm -f C:/Temp/x.txt'), deps(home)), null);
  assert.equal(runRmHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }), deps(home)), null);
});

test('the input cwd is used, and the process cwd when it is missing', () => {
  const home = tempHome();
  assert.match(runRmHook(bash('rm a.ts', 'D:\\other'), deps(home))!, /D:\\\\other\\\\a\.ts/);
  assert.match(runRmHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm a.ts' } }), deps(home))!, /C:\\\\workspace\\\\proj\\\\a\.ts/);
});

test('switched off, nothing is checked', () => {
  const home = tempHome();
  writeConfig(home, { ...DEFAULT_CONFIG, rm: { ...DEFAULT_CONFIG.rm, enabled: false } });
  assert.equal(runRmHook(bash('rm src/a.ts'), deps(home)), null);
});

function runEntry(input: string, home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/rm/hook.ts'], {
    cwd: REPO,
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test('the entry prints the decision for an unresolvable rm', () => {
  const r = runEntry(bash('rm -rf $(echo x)'), tempHome());
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the entry stays silent and exits 0 on empty or broken input', () => {
  for (const input of ['', 'not json', '{"tool_name":']) {
    const r = runEntry(input, tempHome());
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
  }
});
