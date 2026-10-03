import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, writeConfig, type Config } from '../src/config.js';
import type { FetchFn } from '../src/jev.js';
import { dataDir } from '../src/paths.js';
import type { FactProbe } from '../src/rm/facts.js';
import { RM_QUESTIONS, askNote, lifts, passMessage, rmJevRequest } from '../src/rm/judge.js';
import { runRmHook, type RmHookDeps } from '../src/rm/run.js';

const PROJECT = 'C:\\workspace\\proj';
const STARTED = '2026-10-03T01:00:00.000Z';
const AFTER = Date.parse(STARTED) + 60_000;
const NOW = new Date(2026, 9, 3, 10, 0, 0);

function setup(change: (c: Config) => Config = (c) => c): { home: string; transcript: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-rmjev-'));
  const keyFile = path.join(home, 'jev-key.env');
  fs.writeFileSync(keyFile, 'TYPESAFE_API_KEY=ts-test-key\n');
  writeConfig(home, change({ ...DEFAULT_CONFIG, keyFile }));
  const transcript = path.join(home, 'session.jsonl');
  const rows = [
    { type: 'user', timestamp: STARTED, origin: { kind: 'human' }, message: { content: '내보내기 고쳐 줘' } },
    { type: 'assistant', timestamp: STARTED, cwd: PROJECT, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node export.mjs > out.json && head out.json' } }] } },
    { type: 'assistant', timestamp: STARTED, cwd: PROJECT, message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'C:/workspace/proj/scratch/a.json', content: '{}' } }] } },
    { type: 'assistant', timestamp: STARTED, cwd: PROJECT, message: { content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: 'C:/workspace/proj/secret.env', content: 'TYPESAFE_API_KEY=ts-test-key' } }] } },
    { type: 'user', timestamp: STARTED, message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] }, toolUseResult: { type: 'create' } },
    { type: 'user', timestamp: STARTED, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }, toolUseResult: { type: 'create' } },
  ];
  fs.writeFileSync(transcript, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { home, transcript };
}

const input = (transcript: string, command: string, description = 'Clean up the test output') =>
  JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: PROJECT, tool_name: 'Bash', tool_input: { command, description } });

function facts(over: Partial<FactProbe> = {}): FactProbe {
  return {
    info: (p) => ({ folder: p.endsWith('scratch') || p.endsWith('.angular'), bornAt: AFTER }),
    list: () => ({ entries: [{ name: 'a.json', bornAt: AFTER }], more: false }),
    tracked: () => false,
    ignored: (p) => p.endsWith('.angular'),
    ...over,
  };
}

function jev(answers: number[], bodies: string[] = []): FetchFn {
  let i = 0;
  return async (_url, init) => {
    bodies.push(init.body);
    const p = answers[i++];
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model: 'jev-1', answers: { ok: { type: 'noul', noul: p } } }) };
  };
}

const failing: FetchFn = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => 'down' });

const deps = (home: string, fetchFn: FetchFn, probe: FactProbe = facts()): RmHookDeps => ({
  home,
  env: { TEMP: 'C:\\Temp' },
  tmpdir: 'C:\\Temp',
  cwd: PROJECT,
  probe: { exists: () => true, isIgnored: () => false },
  facts: probe,
  fetchFn,
  now: () => NOW,
});

const logLines = (home: string) => fs.readFileSync(path.join(dataDir(home), 'log', '2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a test file this session made passes when Jev is sure, with a line for the user and a log entry', async () => {
  const { home, transcript } = setup();
  const bodies: string[] = [];
  const out = await runRmHook(input(transcript, 'rm -f out.json'), deps(home, jev([0.93], bodies)));
  assert.deepEqual(JSON.parse(out ?? ''), { systemMessage: '[jev-advisor] Jev가 이 세션의 시험 파일로 판단해 묻지 않고 지웁니다: out.json (0.93)' });
  const sent = JSON.parse(bodies[0]);
  assert.deepEqual(sent.state, {
    target: { path: 'C:\\workspace\\proj\\out.json', kind: 'file' },
    command: 'rm -f out.json',
    description: 'Clean up the test output',
    created_by: [{ tool: 'Bash', input: 'node export.mjs > out.json && head out.json' }],
    git: 'untracked',
  });
  assert.deepEqual(sent.questions, { ok: RM_QUESTIONS.session });
  const [log] = logLines(home);
  assert.equal(log.helper, 'rm');
  assert.equal(log.decision, 'pass');
  assert.equal(log.transcriptPath, transcript);
  assert.deepEqual(log.targets, [{ path: 'C:\\workspace\\proj\\out.json', shown: 'C:\\workspace\\proj\\out.json', kind: 'session', p: 0.93 }]);
  assert.equal(JSON.stringify(log).includes('ts-test-key'), false);
});

test('when Jev is not sure, or fails, the ask stays and says what Jev thought', async () => {
  const { home, transcript } = setup();
  const unsure = JSON.parse((await runRmHook(input(transcript, 'rm -f out.json'), deps(home, jev([0.42])))) ?? '');
  assert.equal(unsure.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(unsure.hookSpecificOutput.permissionDecisionReason, '실제 파일 삭제: C:\\workspace\\proj\\out.json · Jev: 시험용 파일일 확률 0.42');
  const down = JSON.parse((await runRmHook(input(transcript, 'rm -f out.json'), deps(home, failing))) ?? '');
  assert.match(down.hookSpecificOutput.permissionDecisionReason, / · Jev: 판단 못 함$/);
  assert.deepEqual(logLines(home).map((l) => l.decision), ['ask', 'ask']);
});

test('Jev is not asked about tracked files, files made before the session, files no call of this session names, or several targets with one of those', async () => {
  const { home, transcript } = setup();
  const bodies: string[] = [];
  const cases: [string, FactProbe][] = [
    ['rm -f out.json', facts({ tracked: () => true })],
    ['rm -f out.json', facts({ info: () => ({ folder: false, bornAt: AFTER - 3_600_000 }) })],
    ['rm -f notes.txt', facts()],
    ['rm -f out.json notes.txt', facts()],
  ];
  for (const [command, probe] of cases) {
    const out = JSON.parse((await runRmHook(input(transcript, command), deps(home, jev([0.99, 0.99], bodies), probe))) ?? '');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', command);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Jev/, command);
  }
  assert.equal(bodies.length, 0);
  assert.equal(fs.existsSync(path.join(dataDir(home), 'log')), false);
});

test('without a key, a transcript, or with rm Jev switched off, the guard decides alone', async () => {
  const bodies: string[] = [];
  const noKey = setup((c) => ({ ...c, keyFile: null }));
  const off = setup((c) => ({ ...c, rm: { ...c.rm, jev: false } }));
  const plain = setup();
  for (const [home, raw] of [
    [noKey.home, input(noKey.transcript, 'rm -f out.json')],
    [off.home, input(off.transcript, 'rm -f out.json')],
    [plain.home, JSON.stringify({ cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'rm -f out.json' } })],
  ]) {
    const out = JSON.parse((await runRmHook(raw, deps(home, jev([0.99], bodies)))) ?? '');
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, '실제 파일 삭제: C:\\workspace\\proj\\out.json');
  }
  assert.equal(bodies.length, 0);
});

test('a folder git ignores gets the rebuild question; a folder this session filled gets the test-file question', async () => {
  const { home, transcript } = setup((c) => ({ ...c, lang: 'en' }));
  const bodies: string[] = [];
  const cache = JSON.parse((await runRmHook(input(transcript, 'rm -rf .angular', 'Clear the build cache'), deps(home, jev([0.97], bodies)))) ?? '');
  assert.equal(cache.systemMessage, '[jev-advisor] Jev judged it a folder that is made again, so it is deleted without asking: .angular (0.97)');
  assert.deepEqual(JSON.parse(bodies[0]).state, {
    target: { path: 'C:\\workspace\\proj\\.angular', kind: 'folder', files: 1, sample: ['a.json'] },
    command: 'rm -rf .angular',
    description: 'Clear the build cache',
    git: 'ignored',
  });
  const scratch = JSON.parse((await runRmHook(input(transcript, 'rm -rf scratch .angular'), deps(home, jev([0.9, 0.95], bodies)))) ?? '');
  assert.equal(scratch.systemMessage, '[jev-advisor] Jev judged these safe to delete, so they are deleted without asking: scratch (0.90), .angular (0.95)');
  assert.deepEqual(JSON.parse(bodies[1]).questions, { ok: RM_QUESTIONS.session });
});

test('one unsure target keeps the ask for the whole command, and every target is listed', async () => {
  const { home, transcript } = setup();
  const out = JSON.parse((await runRmHook(input(transcript, 'rm -rf scratch .angular'), deps(home, jev([0.9, 0.5])))) ?? '');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, / · Jev: scratch 0\.90, \.angular 0\.50$/);
});

test('a failure while gathering facts leaves the plain ask', async () => {
  const { home, transcript } = setup();
  const broken = facts({ tracked: () => { throw new Error('git broke'); } });
  const out = JSON.parse((await runRmHook(input(transcript, 'rm -f out.json'), deps(home, jev([0.99]), broken))) ?? '');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, '실제 파일 삭제: C:\\workspace\\proj\\out.json');
});

test('a deny is never sent to Jev', async () => {
  const { home, transcript } = setup();
  const bodies: string[] = [];
  const out = JSON.parse((await runRmHook(input(transcript, 'rm -rf $(cat list.txt)'), deps(home, jev([0.99], bodies)))) ?? '');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(bodies.length, 0);
});

test('the request cuts long tool calls and caps the folder sample', () => {
  const listing = { entries: Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, bornAt: 0 })), more: true };
  const req = rmJevRequest('ignored', { path: 'C:\\p\\cache', folder: true, bornAt: 0, listing, tracked: false, ignored: true, existedBefore: false, createdBy: [] }, 'rm -rf cache', '');
  assert.deepEqual((req.state.target as Record<string, unknown>).files, 'more than 30');
  assert.equal(((req.state.target as Record<string, unknown>).sample as string[]).length, 10);
  const long = rmJevRequest('session', { path: 'C:\\p\\a.txt', folder: false, bornAt: 0, listing: null, tracked: false, ignored: false, existedBefore: false, createdBy: [{ tool: 'Write', file: 'C:\\p\\a.txt', text: 'x'.repeat(2000), kind: 'create', cwd: 'C:\\p' }] }, 'rm a.txt', '');
  assert.equal(((long.state.created_by as { input: string }[])[0].input).length, 600);
  assert.doesNotMatch(JSON.stringify(RM_QUESTIONS), /[가-힣]/);
});

test('the messages name each target by its file name', () => {
  const item = { path: 'C:\\p\\out.json', shown: 'C:\\p\\out.json', kind: 'session' as const, p: 0.93 };
  assert.equal(passMessage('ko', [item]), '[jev-advisor] Jev가 이 세션의 시험 파일로 판단해 묻지 않고 지웁니다: out.json (0.93)');
  assert.equal(askNote('en', [{ ...item, p: 0.4 }]), ' · Jev: chance it is a test file 0.40');
  assert.equal(askNote('en', [{ ...item, p: null }, { ...item, path: 'C:\\p\\b', p: 0.1 }]), ' · Jev: out.json ?, b 0.10');
});

test('when gathering facts uses up the time budget, the ask stays and Jev is not asked', async () => {
  const { home, transcript } = setup();
  const bodies: string[] = [];
  let t = NOW.getTime();
  const slow = (ms: number) => facts({ tracked: () => ((t += ms), false) });
  const cases: [string, FactProbe][] = [
    ['rm -rf scratch out.json', slow(5500)],
    ['rm -f out.json', slow(11500)],
  ];
  for (const [command, probe] of cases) {
    const out = JSON.parse((await runRmHook(input(transcript, command), { ...deps(home, jev([0.99, 0.99], bodies), probe), now: () => new Date(t) })) ?? '');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', command);
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /Jev/, command);
  }
  assert.equal(bodies.length, 0);
});

test('the key never reaches the log, even when a file this session wrote holds it', async () => {
  const { home, transcript } = setup();
  const bodies: string[] = [];
  const out = JSON.parse((await runRmHook(input(transcript, 'rm -f secret.env'), deps(home, jev([0.3], bodies)))) ?? '');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(bodies.length, 1);
  const text = fs.readFileSync(path.join(dataDir(home), 'log', '2026-10.jsonl'), 'utf8');
  assert.equal(text.includes('ts-test-key'), false);
  assert.match(text, /TYPESAFE_API_KEY=\[redacted\]/);
});

test('nothing is lifted without at least one judged target', () => {
  assert.equal(lifts([], 0.8), false);
  const item = { path: 'C:\\p\\a', shown: 'C:\\p\\a', kind: 'session' as const, p: 0.9 };
  assert.equal(lifts([item], 0.8), true);
  assert.equal(lifts([item, { ...item, p: null }], 0.8), false);
  assert.equal(lifts([{ ...item, p: 0.8 }], 0.8), true);
});
