import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { candidateKind, gatherFacts, namesTarget, readSessionLog, realFactProbe, type FactProbe, type TargetFacts, type ToolCall } from '../src/rm/facts.js';

const PROJECT = 'C:\\workspace\\app';
const START = Date.parse('2026-10-03T01:00:00.000Z');
const bash = (command: string): ToolCall => ({ tool: 'Bash', file: null, text: command });
const write = (file: string, text = 'x'): ToolCall => ({ tool: 'Write', file, text });

function useTool(name: string, input: object, extra: object = {}) {
  return { type: 'assistant', isSidechain: false, timestamp: '2026-10-03T01:05:00.000Z', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't', name, input }] }, ...extra };
}

test('the session log has the first timestamp and the main-chain calls that can write files', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-')), 's.jsonl');
  const rows = [
    { type: 'last-prompt' },
    { type: 'user', timestamp: '2026-10-03T01:00:00.000Z', origin: { kind: 'human' }, message: { content: 'try it' } },
    useTool('Write', { file_path: 'C:\\workspace\\app\\probe.txt', content: 'hello' }),
    useTool('Edit', { file_path: 'C:/workspace/app/a.ts', old_string: 'a', new_string: 'b' }),
    useTool('MultiEdit', { file_path: 'C:/workspace/app/b.ts', edits: [{ new_string: 'one' }, { new_string: 'two' }] }),
    useTool('Bash', { command: 'echo hi > out.json', description: 'Write output' }),
    useTool('Read', { file_path: 'C:/workspace/app/c.ts' }),
    useTool('Bash', { command: 'echo sub > sub.txt' }, { isSidechain: true }),
  ];
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\nbroken line\n`);
  assert.deepEqual(readSessionLog(file), {
    startedAt: START,
    calls: [
      { tool: 'Write', file: 'C:\\workspace\\app\\probe.txt', text: 'hello' },
      { tool: 'Edit', file: 'C:/workspace/app/a.ts', text: 'b' },
      { tool: 'MultiEdit', file: 'C:/workspace/app/b.ts', text: 'one\ntwo' },
      { tool: 'Bash', file: null, text: 'echo hi > out.json' },
    ],
  });
  assert.equal(readSessionLog(file, 100), null);
  assert.equal(readSessionLog(path.join(os.tmpdir(), 'no-such-cja.jsonl')), null);
});

test('a call names the target by its full path in any spelling, or relative to the working folder', () => {
  const target = 'C:\\workspace\\app\\probe.txt';
  assert.equal(namesTarget(write('C:/workspace/app/probe.txt'), target, false, PROJECT), true);
  assert.equal(namesTarget(write('C:\\workspace\\app\\probe.txt.bak'), target, false, PROJECT), false);
  assert.equal(namesTarget(bash('cat /c/workspace/app/probe.txt'), target, false, null), true);
  assert.equal(namesTarget(bash('echo hi > probe.txt && cat probe.txt'), target, false, PROJECT), true);
  assert.equal(namesTarget(bash('echo hi > ./probe.txt'), target, false, PROJECT), true);
  assert.equal(namesTarget(bash('echo hi > "probe.txt"'), target, false, PROJECT), true);
  assert.equal(namesTarget(bash('echo hi > other/probe.txt'), target, false, PROJECT), false);
  assert.equal(namesTarget(bash('echo hi > my-probe.txt'), target, false, PROJECT), false);
  assert.equal(namesTarget(bash('echo hi > probe.txt'), target, false, 'C:\\elsewhere'), false);
});

test('a delete command is no sign of making the target', () => {
  const target = 'C:\\workspace\\app\\probe.txt';
  assert.equal(namesTarget(bash('rm -f probe.txt'), target, false, PROJECT), false);
  assert.equal(namesTarget(bash('ls && rm probe.txt'), target, false, PROJECT), false);
  assert.equal(namesTarget({ tool: 'PowerShell', file: null, text: 'Remove-Item probe.txt' }, target, false, PROJECT), false);
});

test('writing a file inside a folder names the folder', () => {
  const folder = 'C:\\workspace\\app\\tmp-check';
  assert.equal(namesTarget(write('C:/workspace/app/tmp-check/a.json'), folder, true, PROJECT), true);
  assert.equal(namesTarget(write('C:/workspace/app/tmp-check/a.json'), folder, false, PROJECT), false);
  assert.equal(namesTarget(bash('mkdir tmp-check && node fetch.mjs --out tmp-check'), folder, true, PROJECT), true);
});

function fakeProbe(over: Partial<FactProbe> = {}): FactProbe {
  return {
    info: () => ({ folder: false, bornAt: START + 1000 }),
    list: () => ({ entries: [], more: false }),
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
  createdBy: [bash('echo hi > probe.txt')],
  ...over,
});

test('gathered facts keep the last three calls that name the target, and ask git only what applies', () => {
  const session = { startedAt: START, calls: [bash('echo 1 > probe.txt'), bash('echo 2 > probe.txt'), bash('ls'), bash('echo 3 > probe.txt'), bash('echo 4 >> probe.txt')] };
  const asked: string[] = [];
  const probe = fakeProbe({ ignored: (p) => (asked.push(p), true) });
  const f = gatherFacts('C:\\workspace\\app\\probe.txt', PROJECT, session, probe, 50);
  assert.deepEqual(f?.createdBy.map((c) => c.text), ['echo 2 > probe.txt', 'echo 3 > probe.txt', 'echo 4 >> probe.txt']);
  assert.equal(f?.ignored, false);
  assert.deepEqual(asked, []);
  assert.equal(gatherFacts('C:\\gone', PROJECT, session, fakeProbe({ info: () => null }), 50), null);
});

test('a session test file must be untracked, named by a call of this session and made after it started', () => {
  assert.equal(candidateKind(facts(), START), 'session');
  assert.equal(candidateKind(facts({ tracked: true }), START), null);
  assert.equal(candidateKind(facts({ createdBy: [] }), START), null);
  assert.equal(candidateKind(facts({ bornAt: START - 1 }), START), null);
});

test('a session folder also needs every file inside made in the session, and no more files than the limit', () => {
  const folder = (entries: number[], more = false) => facts({ folder: true, listing: { entries: entries.map((t, i) => ({ name: `f${i}`, bornAt: t })), more } });
  assert.equal(candidateKind(folder([START + 5, START + 9]), START), 'session');
  assert.equal(candidateKind(folder([START + 5, START - 9]), START), null);
  assert.equal(candidateKind(folder([START + 5], true), START), null);
  assert.equal(candidateKind(facts({ folder: true, listing: null }), START), null);
});

test('a folder git ignores is the other candidate, whatever its age; a single ignored file is not', () => {
  assert.equal(candidateKind(facts({ folder: true, ignored: true, tracked: true, createdBy: [], bornAt: 0, listing: { entries: [], more: true } }), START), 'ignored');
  assert.equal(candidateKind(facts({ folder: false, ignored: true, tracked: true }), START), null);
});

test('the real probe reads git, birth times and listings', { skip: process.platform !== 'win32' && 'the rm helper runs on Windows only' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-facts-git-'));
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'cache/\n');
  fs.writeFileSync(path.join(repo, 'kept.txt'), 'k');
  git('add', '.gitignore', 'kept.txt');
  fs.writeFileSync(path.join(repo, 'probe.txt'), 'p');
  fs.mkdirSync(path.join(repo, 'cache', 'deep'), { recursive: true });
  for (const name of ['a', 'b', 'deep/c']) fs.writeFileSync(path.join(repo, 'cache', name), name);
  assert.equal(realFactProbe.tracked(path.join(repo, 'kept.txt')), true);
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
});
