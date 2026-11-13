import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PS_PARSE_TIMEOUT_MS } from '../src/rm/powershell.js';
import { GIT_TIMEOUT_MS, type GitRunner } from '../src/rm/git.js';
import { READ_BUDGET_MS, RECOVER_BUDGET_MS, runRmHook, type RmHookDeps } from '../src/rm/run.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';
import { logFile } from '../src/context/files.js';

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


const NOW = new Date(2026, 10, 13, 9, 0, 0);
const records = (home: string): Record<string, any>[] => {
  const file = logFile(home, NOW);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const logged = (home: string, extra: Partial<RmHookDeps> = {}): RmHookDeps => ({ ...deps(home), now: () => NOW, ...extra });

test('every rm decision is logged once: passed-over targets, an ask and a deny', async () => {
  const home = tempHome();
  await runRmHook(bash('rm -f C:/Temp/x.txt'), logged(home));
  await runRmHook(bash('rm src/a.ts'), logged(home));
  await runRmHook(bash('rm $X'), logged(home));
  await runRmHook(bash('ls -la'), logged(home));
  const [none, ask, deny, ...rest] = records(home);
  assert.equal(rest.length, 0);
  assert.equal(none.helper, 'rm');
  assert.equal(none.event, 'pre_tool_use');
  assert.equal(none.decision, 'none');
  assert.deepEqual(none.targets, []);
  assert.deepEqual(none.skipped, [{ shown: 'C:\\Temp\\x.txt', why: 'temp' }]);
  assert.equal(ask.decision, 'ask');
  assert.match(ask.reason, /^실제 파일 삭제: /);
  assert.deepEqual(ask.targets, [{ shown: 'C:\\workspace\\proj\\src\\a.ts', path: 'C:\\workspace\\proj\\src\\a.ts', lift: null }]);
  assert.deepEqual(ask.skipped, []);
  assert.equal(ask.sessionId, null);
  assert.equal(ask.jev, undefined);
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /^rm-guard could not work out/);
  assert.deepEqual(deny.targets, []);
});

test('the record keeps the tool use id and agent id when given, and cuts the command and the reason', async () => {
  const home = tempHome();
  const long = `rm ${'a'.repeat(3000)}`;
  await runRmHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: long }, cwd: 'C:\\workspace\\proj', tool_use_id: 'toolu_1', agent_id: 'a1', session_id: 's1' }), logged(home));
  await runRmHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm src/a.ts' }, tool_use_id: 7, agent_id: {} }), logged(home));
  const [first, second] = records(home);
  assert.equal(first.toolUseId, 'toolu_1');
  assert.equal(first.agentId, 'a1');
  assert.equal(first.sessionId, 's1');
  assert.equal(first.command.length, 2000);
  assert.equal(first.reason.length, 500);
  assert.equal('toolUseId' in second, false);
  assert.equal('agentId' in second, false);
});

test('a digit-variable guess never puts its control character into the record', async () => {
  const home = tempHome();
  await runRmHook(bash('rm -f "/tmp/a_$$"'), logged(home));
  const [record] = records(home);
  assert.equal(record.decision, 'none');
  assert.equal(record.skipped.length, 1);
  assert.equal(record.skipped[0].why, 'temp');
  assert.equal(/[\u0000-\u0008\u000b-\u001f]/.test(record.skipped[0].shown), false);
});

test('a log that cannot be written never changes the output', async () => {
  const home = tempHome();
  fs.mkdirSync(logFile(home, NOW), { recursive: true });
  const out = await runRmHook(bash('rm src/a.ts'), logged(home));
  assert.equal(JSON.parse(out!).hookSpecificOutput.permissionDecision, 'ask');
});

test('the key never reaches the record even when the cut falls inside it', async () => {
  const home = tempHome();
  const key = 'ts-test-key-0123456789';
  await runRmHook(bash(`rm ${'a'.repeat(1990)}${key}`), logged(home, { env: { TEMP: 'C:\\Temp', TYPESAFE_API_KEY: key } }));
  assert.equal(fs.readFileSync(logFile(home, NOW), 'utf8').includes('ts-test-k'), false);
});

const WINDOWS_ONLY = { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' };
const gitIn = (repo: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
function repoWith(files: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rmrec-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), text);
  gitIn(repo, 'add', '.');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}
const slashes = (p: string) => p.replace(/\\/g, '/');
const recoverDeps = (home: string, extra: Partial<RmHookDeps> = {}): RmHookDeps => ({ ...deps(home), now: () => NOW, ...extra });

test('a tracked unchanged file is deleted without asking, with a line that says it is in git', WINDOWS_ONLY, async () => {
  const home = tempHome();
  const repo = repoWith({ 'a.md': 'a\n' });
  try {
    const out = await runRmHook(bash(`rm "${slashes(repo)}/a.md"`), recoverDeps(home));
    assert.deepEqual(JSON.parse(out!), { systemMessage: '[jev-advisor] 되살릴 수 있어 묻지 않고 지웁니다: a.md (git)' });
    const [record] = records(home);
    assert.equal(record.decision, 'pass');
    assert.equal(record.targets[0].lift, 'git');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a changed file still asks and says it changed', WINDOWS_ONLY, async () => {
  const home = tempHome();
  const repo = repoWith({ 'a.md': 'a\n' });
  fs.writeFileSync(path.join(repo, 'a.md'), 'edited\n');
  try {
    const out = JSON.parse((await runRmHook(bash(`rm "${slashes(repo)}/a.md"`), recoverDeps(home)))!);
    const file = path.win32.normalize(`${slashes(repo)}/a.md`);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, `실제 파일 삭제: ${file} · 바뀜: a.md`);
    assert.equal(records(home)[0].targets[0].note, '바뀜: a.md');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a vault file with an identical repository copy named in the command is deleted without asking', WINDOWS_ONLY, async () => {
  const home = tempHome();
  const repo = repoWith({ 'n.md': 'note\n' });
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rmvault-'));
  fs.writeFileSync(path.join(vault, 'n.md'), 'note\n');
  try {
    const out = JSON.parse((await runRmHook(bash(`rm "${slashes(vault)}/n.md" && cp "${slashes(repo)}/n.md" "${slashes(vault)}/n.md"`), recoverDeps(home)))!);
    assert.match(out.systemMessage, /n\.md \(사본 n\.md\)$/);
    assert.equal(out.hookSpecificOutput, undefined);
    assert.equal(records(home)[0].targets[0].lift, 'copy');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  }
});

test('a Bash copy onto the deleted file through an unquoted backslash still asks, since Git Bash writes elsewhere', WINDOWS_ONLY, async () => {
  const home = tempHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rmesc-'));
  fs.writeFileSync(path.join(dir, 'n.md'), 'note\n');
  fs.writeFileSync(path.join(dir, '.n.md'), 'note\n');
  fs.writeFileSync(path.join(dir, 'x.md'), 'x\n');
  try {
    const out = JSON.parse((await runRmHook(bash('rm n.md; cat .n.md; cp x.md .\\n.md', dir), recoverDeps(home)))!);
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(records(home)[0].targets[0].lift, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with recoverable switched off the ask is exactly as before', WINDOWS_ONLY, async () => {
  const home = tempHome();
  writeConfig(home, { ...DEFAULT_CONFIG, rm: { ...DEFAULT_CONFIG.rm, recoverable: false } });
  const repo = repoWith({ 'a.md': 'a\n' });
  try {
    const out = JSON.parse((await runRmHook(bash(`rm "${slashes(repo)}/a.md"`), recoverDeps(home)))!);
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, `실제 파일 삭제: ${path.win32.normalize(`${slashes(repo)}/a.md`)}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('when recovery runs out of time the rest asks and the hook still answers', async () => {
  const home = tempHome();
  let clock = 0;
  const fakeGit: GitRunner = (args) => {
    clock += GIT_TIMEOUT_MS;
    return { status: 0, stdout: args[2] === 'ls-files' ? 'H x\0' : '', stderr: '' };
  };
  const names = ['a', 'b', 'c', 'd'].map((n) => `C:/data/${n}.md`);
  const out = JSON.parse((await runRmHook(bash(`rm ${names.join(' ')}`), recoverDeps(home, { git: fakeGit, now: () => new Date(clock) })))!);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  const reason: string = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /C:\\data\\b\.md/);
  assert.doesNotMatch(reason, /C:\\data\\a\.md/);
  assert.ok(clock <= RECOVER_BUDGET_MS + GIT_TIMEOUT_MS, `clock ${clock}`);
});

test('a throw after the guard decided leaves the guard ask', async () => {
  const home = tempHome();
  let boom = false;
  const fakeGit: GitRunner = () => {
    boom = true;
    return { status: 128, stdout: '', stderr: '' };
  };
  const clock = () => {
    if (boom) throw new Error('clock failed');
    return new Date(NOW);
  };
  const out = JSON.parse((await runRmHook(bash('rm C:/data/a.md'), recoverDeps(home, { git: fakeGit, now: clock })))!);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, '실제 파일 삭제: C:\\data\\a.md');
});
