import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PS_PARSE_TIMEOUT_MS } from '../src/rm/powershell.js';
import { READ_BUDGET_MS, runRmHook, type RmHookDeps } from '../src/rm/run.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';

const REPO = path.resolve(import.meta.dirname, '..');
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rm-'));
const bash = (command: string, cwd = 'C:\\workspace\\proj') => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });

function deps(home: string): RmHookDeps {
  return { home, env: { TEMP: 'C:\\Temp' }, tmpdir: 'C:\\Temp', cwd: 'C:\\workspace\\proj', probe: { exists: () => true, isIgnored: () => false } };
}

test('a real file asks', async () => {
  const out = await runRmHook(bash('rm src/a.ts'), deps(tempHome()));
  assert.equal(JSON.parse(out!).hookSpecificOutput.permissionDecision, 'ask');
});

test('a temp file and other tools give no output', async () => {
  const home = tempHome();
  assert.equal(await runRmHook(bash('rm -f C:/Temp/x.txt'), deps(home)), null);
  assert.equal(await runRmHook(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a' } }), deps(home)), null);
});

test('the input cwd is used, and the process cwd when it is missing', async () => {
  const home = tempHome();
  assert.match((await runRmHook(bash('rm a.ts', 'D:\\other'), deps(home)))!, /D:\\\\other\\\\a\.ts/);
  assert.match((await runRmHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm a.ts' } }), deps(home)))!, /C:\\\\workspace\\\\proj\\\\a\.ts/);
});

test('PowerShell tool calls are checked too, and PowerShell only starts when the command has a delete word', async () => {
  const home = tempHome();
  let runs = 0;
  const powershell = async () => {
    runs++;
    return JSON.stringify({ errors: false, anyVariable: false, unstable: [], items: [{ kind: 'delete', path: { const: 'src\\a.ts' }, literalPath: null, literal: false, dotnet: false, whatIf: false, bindError: false, inPipeline: false, ordered: true }] });
  };
  const ps = (command: string) => JSON.stringify({ tool_name: 'PowerShell', tool_input: { command }, cwd: 'C:\\workspace\\proj' });
  const out = JSON.parse((await runRmHook(ps('Remove-Item src\\a.ts'), { ...deps(home), powershell }))!);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /C:\\workspace\\proj\\src\\a\.ts/);
  assert.equal(await runRmHook(ps('Get-ChildItem; git status'), { ...deps(home), powershell }), null);
  assert.equal(runs, 1);
});

test('a PowerShell command that cannot be read asks instead of passing', async () => {
  const out = JSON.parse((await runRmHook(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'Remove-Item x' } }), { ...deps(tempHome()), powershell: async () => null }))!);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, '삭제 명령을 분석하지 못함: Remove-Item x');
  assert.equal(await runRmHook(JSON.stringify({ tool_name: 'PowerShell', tool_input: {} }), deps(tempHome())), null);
});

test('no PowerShell read starts once the read budget is spent, so slow reads ask before the hook limit', async () => {
  let clock = 0;
  let runs = 0;
  const powershell = async () => {
    runs++;
    clock += PS_PARSE_TIMEOUT_MS;
    return null;
  };
  const command = Array.from({ length: 6 }, (_, i) => `powershell -c "Remove-Item C:/data/a${i}.txt"`).join('; ');
  const out = JSON.parse((await runRmHook(bash(command), { ...deps(tempHome()), powershell, now: () => new Date(clock) }))!);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^삭제 명령을 분석하지 못함: /);
  assert.equal(runs, Math.ceil(READ_BUDGET_MS / PS_PARSE_TIMEOUT_MS));
  assert.ok(clock <= READ_BUDGET_MS + PS_PARSE_TIMEOUT_MS);
});

test('switched off, nothing is checked', async () => {
  const home = tempHome();
  writeConfig(home, { ...DEFAULT_CONFIG, rm: { ...DEFAULT_CONFIG.rm, enabled: false } });
  assert.equal(await runRmHook(bash('rm src/a.ts'), deps(home)), null);
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

test('the entry reads a PowerShell deletion with the real PowerShell', { skip: process.platform !== 'win32' && 'PowerShell parsing is checked on Windows only' }, () => {
  const r = runEntry(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem *.log | Remove-Item' }, cwd: 'C:\\workspace\\proj' }), tempHome());
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /pipeline input feeding Remove-Item/);
});

test('the entry stays silent and exits 0 on empty or broken input', () => {
  for (const input of ['', 'not json', '{"tool_name":']) {
    const r = runEntry(input, tempHome());
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
  }
});

test('the entry decodes a multi-byte character split across stdin chunks', () => {
  const build = (filler: number) => bash(`echo ${'a'.repeat(filler)}\nrm -rf "$(echo 한글)"`);
  const base = Buffer.from(build(0), 'utf8').indexOf('한');
  for (let offset = 65536 - 3; offset <= 65536 + 3; offset++) {
    const input = build(offset - base);
    assert.equal(Buffer.from(input, 'utf8').indexOf('한'), offset);
    const r = runEntry(input, tempHome());
    assert.equal(r.status, 0, `offset ${offset}`);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /한글/, `offset ${offset}`);
  }
});
