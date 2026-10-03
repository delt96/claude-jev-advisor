import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateKind, createsTarget, gatherFacts, namesTarget, readSessionLog, realFactProbe, type CallKind, type FactProbe, type TargetFacts, type ToolCall } from '../src/rm/facts.js';

const PROJECT = 'C:\\workspace\\app';
const START = Date.parse('2026-10-03T01:00:00.000Z');
const bash = (command: string, cwd: string | null = PROJECT): ToolCall => ({ tool: 'Bash', file: null, text: command, kind: 'shell', cwd });
const write = (file: string, text = 'x', kind: CallKind = 'create'): ToolCall => ({ tool: 'Write', file, text, kind, cwd: PROJECT });

function useTool(name: string, input: object, extra: object = {}, id = 't') {
  return { type: 'assistant', isSidechain: false, cwd: PROJECT, timestamp: '2026-10-03T01:05:00.000Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id, name, input }] }, ...extra };
}

function toolResult(id: string, result: unknown) {
  return { type: 'user', timestamp: '2026-10-03T01:05:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, toolUseResult: result };
}

test('the session log has the first timestamp and the main-chain calls that touch files, with what each did and where it ran', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-')), 's.jsonl');
  const rows = [
    { type: 'last-prompt' },
    { type: 'user', timestamp: '2026-10-03T01:00:00.000Z', origin: { kind: 'human' }, message: { content: 'try it' } },
    useTool('Write', { file_path: 'C:\\workspace\\app\\probe.txt', content: 'hello' }, {}, 'w1'),
    toolResult('w1', { type: 'create' }),
    useTool('Edit', { file_path: 'C:/workspace/app/a.ts', old_string: 'a', new_string: 'b' }, {}, 'e1'),
    useTool('MultiEdit', { file_path: 'C:/workspace/app/b.ts', edits: [{ new_string: 'one' }, { new_string: 'two' }] }, {}, 'm1'),
    useTool('Bash', { command: 'echo hi > out.json', description: 'Write output' }, { cwd: 'C:\\workspace\\app\\docs' }, 'b1'),
    useTool('Read', { file_path: 'C:/workspace/app/c.ts' }, {}, 'r1'),
    useTool('Write', { file_path: 'C:/workspace/app/notes.md', content: 'n' }, {}, 'w2'),
    toolResult('w2', { type: 'update' }),
    useTool('Write', { file_path: 'C:/workspace/app/old.md', content: 'o' }, {}, 'w3'),
    toolResult('w3', 'Error: File has not been read yet. Read it first before writing to it.'),
    useTool('Write', { file_path: 'C:/workspace/app/pending.md', content: 'p' }, {}, 'w4'),
    useTool('Bash', { command: 'ls' }, { cwd: 42 }, 'b3'),
    useTool('Glob', { pattern: '*.ts' }, {}, 'g1'),
    useTool('Bash', { command: 'echo sub > sub.txt' }, { isSidechain: true }, 'b2'),
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nbroken line\n`);
  assert.deepEqual(readSessionLog(file), {
    startedAt: START,
    calls: [
      { tool: 'Write', file: 'C:\\workspace\\app\\probe.txt', text: 'hello', kind: 'create', cwd: PROJECT },
      { tool: 'Edit', file: 'C:/workspace/app/a.ts', text: 'b', kind: 'change', cwd: PROJECT },
      { tool: 'MultiEdit', file: 'C:/workspace/app/b.ts', text: 'one\ntwo', kind: 'change', cwd: PROJECT },
      { tool: 'Bash', file: null, text: 'echo hi > out.json', kind: 'shell', cwd: 'C:\\workspace\\app\\docs' },
      { tool: 'Read', file: 'C:/workspace/app/c.ts', text: '', kind: 'read', cwd: PROJECT },
      { tool: 'Write', file: 'C:/workspace/app/notes.md', text: 'n', kind: 'change', cwd: PROJECT },
      { tool: 'Write', file: 'C:/workspace/app/old.md', text: 'o', kind: 'change', cwd: PROJECT },
      { tool: 'Write', file: 'C:/workspace/app/pending.md', text: 'p', kind: 'change', cwd: PROJECT },
      { tool: 'Bash', file: null, text: 'ls', kind: 'shell', cwd: null },
    ],
  });
  assert.equal(readSessionLog(file, 100), null);
  assert.equal(readSessionLog(path.join(os.tmpdir(), 'no-such-cja.jsonl')), null);
});

test('a call names the target by its full path in any spelling, or relative to the folder the call ran in', () => {
  const target = 'C:\\workspace\\app\\probe.txt';
  assert.equal(namesTarget(write('C:/workspace/app/probe.txt'), target, false), true);
  assert.equal(namesTarget(write('C:\\workspace\\app\\probe.txt.bak'), target, false), false);
  assert.equal(namesTarget(bash('cat /c/workspace/app/probe.txt', null), target, false), true);
  assert.equal(namesTarget(bash('echo hi > probe.txt && cat probe.txt'), target, false), true);
  assert.equal(namesTarget(bash('echo hi > ./probe.txt'), target, false), true);
  assert.equal(namesTarget(bash('echo hi > "probe.txt"'), target, false), true);
  assert.equal(namesTarget(bash('echo hi > other/probe.txt'), target, false), false);
  assert.equal(namesTarget(bash('echo hi > my-probe.txt'), target, false), false);
  assert.equal(namesTarget(bash('echo hi > probe.txt', 'C:\\elsewhere'), target, false), false);
  assert.equal(namesTarget(bash('echo hi > probe.txt', null), target, false), false);
});

test('a relative name made in one folder is not a file of the same name in the folder the rm runs in later', () => {
  const made = bash('echo hi > notes.md', 'C:\\proj');
  assert.equal(namesTarget(made, 'C:\\proj\\docs\\notes.md', false), false);
  assert.equal(createsTarget(made, 'C:\\proj\\docs\\notes.md'), false);
  assert.equal(gatherFacts('C:\\proj\\docs\\notes.md', { startedAt: START, calls: [made] }, fakeProbe(), 50)?.existedBefore, true);
  assert.equal(namesTarget(made, 'C:\\proj\\notes.md', false), true);
  assert.equal(createsTarget(made, 'C:\\proj\\notes.md'), true);
  assert.equal(createsTarget(bash('cd docs && echo hi > ../notes.md', 'C:\\proj'), 'C:\\proj\\notes.md'), false);
});

test('a delete command, in any spelling, is no sign of making the target', () => {
  const target = 'C:\\workspace\\app\\probe.txt';
  for (const command of [
    'rm -f probe.txt',
    'ls && rm probe.txt',
    '/usr/bin/rm -f probe.txt',
    'rm.exe -f probe.txt',
    '"rm" -f probe.txt',
    '\\rm -f probe.txt',
    "'rm' probe.txt",
    'C:/msys64/usr/bin/rm.exe probe.txt',
    'echo done;/bin/rm probe.txt',
    'cmd /c del probe.txt',
    "xargs -0 echo; r''m -f probe.txt",
  ]) {
    assert.equal(namesTarget(bash(command), target, false), false, command);
  }
  for (const command of ['Remove-Item probe.txt', 'ri probe.txt', 'del probe.txt']) {
    assert.equal(namesTarget({ tool: 'PowerShell', file: null, text: command, kind: 'shell', cwd: PROJECT }, target, false), false, command);
  }
});

test('writing a file inside a folder names the folder', () => {
  const folder = 'C:\\workspace\\app\\tmp-check';
  assert.equal(namesTarget(write('C:/workspace/app/tmp-check/a.json'), folder, true), true);
  assert.equal(namesTarget(write('C:/workspace/app/tmp-check/a.json'), folder, false), false);
  assert.equal(namesTarget(bash('mkdir tmp-check && node fetch.mjs --out tmp-check'), folder, true), true);
});

function fakeProbe(over: Partial<FactProbe> = {}): FactProbe {
  return {
    info: () => ({ folder: false, bornAt: START + 1000 }),
    list: () => ({ entries: [], more: false, repo: false }),
    tracked: () => false,
    ignored: () => false,
    ...over,
  };
}

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  path: 'C:\\workspace\\app\\probe.txt',
  folder: false,
  bornAt: START + 1000,
  listing: null,
  tracked: false,
  ignored: false,
  existedBefore: false,
  createdBy: [bash('echo hi > probe.txt')],
  ...over,
});

test('gathered facts keep the first call that names the target and the last two, and ask git only what applies', () => {
  const session = { startedAt: START, calls: [bash('echo 1 > probe.txt'), bash('echo 2 > probe.txt'), bash('ls'), bash('echo 3 > probe.txt'), bash('echo 4 >> probe.txt')] };
  const asked: string[] = [];
  const probe = fakeProbe({ ignored: (p) => (asked.push(p), true) });
  const f = gatherFacts('C:\\workspace\\app\\probe.txt', session, probe, 50);
  assert.deepEqual(f?.createdBy.map((c) => c.text), ['echo 1 > probe.txt', 'echo 3 > probe.txt', 'echo 4 >> probe.txt']);
  assert.equal(f?.ignored, false);
  assert.equal(f?.existedBefore, false);
  assert.deepEqual(asked, []);
  assert.equal(gatherFacts('C:\\gone', session, fakeProbe({ info: () => null }), 50), null);
});

test('a shell command creates the target only by a redirect, touch, mkdir or curl -o', () => {
  const file = 'C:\\workspace\\app\\probe.txt';
  const folder = 'C:\\workspace\\app\\tmp-check';
  for (const [command, target, expected] of [
    ['echo hi > probe.txt', file, true],
    ['echo hi >probe.txt && cat probe.txt', file, true],
    ['node export.mjs > "./probe.txt"', file, true],
    ['node export.mjs 2> /c/workspace/app/probe.txt', file, true],
    ['npm test &> probe.txt', file, true],
    ['cat <<EOF > probe.txt\nhello > other.txt\nEOF', file, true],
    ['touch probe.txt', file, true],
    ['FOO=1 /usr/bin/touch.exe probe.txt', file, true],
    ['curl -s -o probe.txt https://example.com', file, true],
    ['mkdir tmp-check && node fetch.mjs', folder, true],
    ['cd sub && echo hi > C:/workspace/app/probe.txt', file, true],
    ['echo hi > probe.txt # first try', file, true],
    ['node fetch.mjs --out tmp-check', folder, false],
    ['echo more >> probe.txt', file, false],
    ['echo hi >| probe.txt', file, false],
    ['npm test > out.log 2>&1 && cat probe.txt', file, false],
    ['cat probe.txt', file, false],
    ["sed -i 's/a/b/' probe.txt", file, false],
    ['echo hi > other/probe.txt', file, false],
    ['echo hi > my-probe.txt', file, false],
    ['cp notes.md probe.txt', file, false],
    ["mkdir -p backup\nsed -i 's/old/new/' probe.txt", file, false],
    ["touch .done\nsed -i 's/old/new/' probe.txt", file, false],
    ["# touch up wording\nsed -i 's/old/new/' probe.txt", file, false],
    ["# old.txt -> probe.txt\nsed -i 's/x/y/' probe.txt", file, false],
    ["sed -i 's/x/y/' probe.txt  # copy a > probe.txt", file, false],
    ["sed -i 's/x/y/' probe.txt # done; touch probe.txt", file, false],
    ["sed -i 's/x/y/' src/apple-touch-icon.svg probe.txt", file, false],
    ["perl -pi -e 's/a/b/' scripts/mkdir.js probe.txt", file, false],
    ['echo "save it with > probe.txt"', file, false],
    ['git commit -m "redirect > probe.txt"', file, false],
    ['cat <<EOF > other.txt\nhello > probe.txt\nEOF', file, false],
    ['ls -o probe.txt', file, false],
    ['unzip -o probe.txt', file, false],
    ['python -O probe.txt', file, false],
    ['cd docs && echo hi > probe.txt', file, false],
  ] as const) {
    assert.equal(createsTarget(bash(command), target), expected, command);
  }
  assert.equal(createsTarget(write(file), file), true);
  assert.equal(createsTarget(write(file, 'x', 'change'), file), false);
  assert.equal(createsTarget({ tool: 'Read', file, text: '', kind: 'read', cwd: PROJECT }, file), false);
});

test('a target counts as made in this session only when the first call naming it visibly created it', () => {
  const target = 'C:\\workspace\\app\\probe.txt';
  const edit: ToolCall = { tool: 'Edit', file: target, text: 'b', kind: 'change', cwd: PROJECT };
  const read: ToolCall = { tool: 'Read', file: target, text: '', kind: 'read', cwd: PROJECT };
  const existed = (calls: ToolCall[]) => gatherFacts(target, { startedAt: START, calls }, fakeProbe(), 50)?.existedBefore;
  assert.equal(existed([write(target), edit]), false);
  assert.equal(existed([bash('echo hi > probe.txt'), edit]), false);
  assert.equal(existed([edit]), true);
  assert.equal(existed([read, write(target)]), true);
  assert.equal(existed([write(target, 'x', 'change')]), true);
  assert.equal(existed([bash('cat probe.txt'), read, edit]), true);
  assert.equal(existed([bash("sed -i 's/a/b/' probe.txt")]), true);
  assert.equal(existed([]), true);
  assert.equal(candidateKind(facts({ existedBefore: true }), START), null);
});

test('a session test file must be untracked, named by a call of this session and made after it started', () => {
  assert.equal(candidateKind(facts(), START), 'session');
  assert.equal(candidateKind(facts({ tracked: true }), START), null);
  assert.equal(candidateKind(facts({ createdBy: [] }), START), null);
  assert.equal(candidateKind(facts({ bornAt: START - 1 }), START), null);
});

test('a session folder also needs every file inside made in the session, and no more files than the limit', () => {
  const folder = (entries: number[], more = false) => facts({ folder: true, listing: { entries: entries.map((t, i) => ({ name: `f${i}`, bornAt: t })), more, repo: false } });
  assert.equal(candidateKind(folder([START + 5, START + 9]), START), 'session');
  assert.equal(candidateKind(folder([START + 5, START - 9]), START), null);
  assert.equal(candidateKind(folder([START + 5], true), START), null);
  assert.equal(candidateKind(facts({ folder: true, listing: null }), START), null);
});

test('a folder git ignores is the other candidate, whatever its age; a single ignored file is not', () => {
  assert.equal(candidateKind(facts({ folder: true, ignored: true, createdBy: [], bornAt: 0, listing: { entries: [], more: true, repo: false } }), START), 'ignored');
  assert.equal(candidateKind(facts({ folder: true, ignored: true, createdBy: [], bornAt: 0, listing: { entries: [], more: false, repo: true } }), START), null);
  assert.equal(candidateKind(facts({ folder: false, ignored: true, existedBefore: true }), START), null);
});

test('the real probe reads git, birth times and listings', { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-git-'));
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\nnested/\n');
  fs.writeFileSync(path.join(repo, 'Kept.txt'), 'k');
  git('add', '.gitignore', 'Kept.txt');
  fs.writeFileSync(path.join(repo, 'probe.txt'), 'p');
  fs.mkdirSync(path.join(repo, 'cache', 'deep'), { recursive: true });
  for (const name of ['a', 'b', 'deep/c']) fs.writeFileSync(path.join(repo, 'cache', name), name);
  assert.equal(realFactProbe.tracked(path.join(repo, 'Kept.txt')), true);
  assert.equal(realFactProbe.tracked(path.join(repo, 'KEPT.TXT')), true);
  assert.equal(realFactProbe.tracked(path.join(repo, 'probe.txt')), false);
  assert.equal(realFactProbe.ignored(path.join(repo, 'cache')), true);
  assert.equal(realFactProbe.ignored(path.join(repo, 'probe.txt')), false);
  const info = realFactProbe.info(path.join(repo, 'probe.txt'));
  assert.equal(info?.folder, false);
  assert.ok(Math.abs((info?.bornAt ?? 0) - Date.now()) < 60_000);
  assert.deepEqual(realFactProbe.list(path.join(repo, 'cache'), 50)?.entries.map((e) => e.name).sort(), ['a', 'b', 'deep/c']);
  assert.equal(realFactProbe.list(path.join(repo, 'cache'), 2)?.more, true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-nogit-'));
  fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
  assert.equal(realFactProbe.tracked(path.join(outside, 'x.txt')), false);
  assert.equal(realFactProbe.tracked(path.join(outside, 'no-such-folder', 'x.txt')), true);
});

test('a repository of its own counts as tracked and never as an ignored cache', { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-nested-'));
  spawnSync('git', ['-C', repo, 'init', '-q']);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'nested/\n');
  const nested = path.join(repo, 'nested');
  fs.mkdirSync(nested);
  spawnSync('git', ['-C', nested, 'init', '-q']);
  assert.equal(realFactProbe.tracked(nested), true);
  assert.equal(realFactProbe.ignored(nested), false);
  assert.equal(realFactProbe.tracked(repo), true);
});

test('folders count toward the listing limit, so a tree of empty folders stops early', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-tree-'));
  for (const name of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, name));
  assert.deepEqual(realFactProbe.list(root, 2), { entries: [], more: true, repo: false });
  assert.deepEqual(realFactProbe.list(root, 3), { entries: [], more: false, repo: false });
});

test('after a cd in one call, the later calls of the same message count only by full paths', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-cd-')), 's.jsonl');
  const call = (message: string, id: string, command: string) => ({
    type: 'assistant',
    cwd: 'C:\\proj',
    timestamp: '2026-10-03T01:05:00.000Z',
    message: { id: message, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const rows = [
    { type: 'user', timestamp: '2026-10-03T01:00:00.000Z', origin: { kind: 'human' }, message: { content: 'go' } },
    call('m1', 'b1', 'cd docs'),
    call('m1', 'b2', 'echo hi > notes.md'),
    call('m2', 'b3', 'echo hi > other.md'),
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const session = readSessionLog(file);
  assert.deepEqual(session?.calls.map((c) => c.cwd), ['C:\\proj', null, 'C:\\proj']);
  assert.equal(gatherFacts('C:\\proj\\notes.md', session!, fakeProbe(), 50)?.existedBefore, true);
});

test('a git repository or worktree inside an ignored folder keeps it from being judged as a cache', { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-worktrees-'));
  fs.mkdirSync(path.join(root, 'feat'));
  fs.writeFileSync(path.join(root, 'feat', '.git'), 'gitdir: C:/somewhere/.git/worktrees/feat');
  fs.writeFileSync(path.join(root, 'feat', 'work.ts'), 'x');
  assert.equal(realFactProbe.list(root, 50)?.repo, true);
});
