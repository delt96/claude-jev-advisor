import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_CONFIG, writeConfig, type Config } from '../src/config.js';
import { readState, writeState } from '../src/context/files.js';
import { runContextHook, type ContextHookDeps } from '../src/context/run.js';
import type { FetchFn } from '../src/jev.js';
import { dataDir } from '../src/paths.js';

const REPO = path.resolve(import.meta.dirname, '..');
const NOW = new Date(2026, 9, 2, 21, 0, 0);
const REPLY = '수정하고 테스트까지 통과했습니다.';

function setup(change: (c: Config) => Config = (c) => c): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-ctx-'));
  const keyFile = path.join(home, 'jev-key.env');
  fs.writeFileSync(keyFile, 'TYPESAFE_API_KEY=ts-test-key\n');
  writeConfig(home, change({ ...DEFAULT_CONFIG, keyFile }));
  return home;
}

function transcript(home: string, size: number): string {
  const file = path.join(home, 'session.jsonl');
  const entries = [
    { type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: '로그인 화면 고쳐 줘' } },
    { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: REPLY }], usage: { input_tokens: 1, cache_read_input_tokens: size - 1, cache_creation_input_tokens: 0 } } },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

const stop = (transcriptPath: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'sess-1', transcript_path: transcriptPath, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: REPLY, background_tasks: [], ...extra });

function jev(unit: number, stage: number, calls: string[] = []): FetchFn {
  return async (_url, init) => {
    calls.push(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ model: 'jev-1', answers: { unit_done: { type: 'noul', noul: unit }, phase_done: { type: 'noul', noul: stage } } }),
    };
  };
}

const failing: FetchFn = async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => 'boom' });
const deps = (home: string, fetchFn: FetchFn, sleep: (ms: number) => Promise<void> = async () => {}): ContextHookDeps => ({ home, env: {}, now: () => NOW, fetchFn, sleep });
const logLines = (home: string) =>
  fs.readFileSync(path.join(dataDir(home), 'log', '2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a finished stage at 312k is judged clear, saved for the display and logged with what Jev saw', async () => {
  const home = setup();
  const calls: string[] = [];
  const out = await runContextHook('stop', stop(transcript(home, 312000)), deps(home, jev(0.9, 0.85, calls)));
  assert.equal(out, null);
  assert.deepEqual(readState(home, 'sess-1'), { sessionId: 'sess-1', at: NOW.getTime(), size: 312000, judgment: { phase: 'unit_done', clear: true } });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]).state, { recent_requests: ['로그인 화면 고쳐 줘'], last_assistant_reply: REPLY });
  const [log] = logLines(home);
  assert.equal(log.event, 'stop');
  assert.equal(log.size, 312000);
  assert.equal(log.reason, null);
  assert.deepEqual(log.jev.answers, { unit_done: 0.9, phase_done: 0.85 });
  assert.equal(log.jev.state.last_assistant_reply, REPLY);
  assert.equal(JSON.stringify(log).includes('ts-test-key'), false);
});

test('with display message the advice is printed as a systemMessage, and nothing when there is no advice', async () => {
  const home = setup((c) => ({ ...c, display: 'message' }));
  const out = await runContextHook('stop', stop(transcript(home, 312000)), deps(home, jev(0.9, 0.2)));
  assert.deepEqual(JSON.parse(out ?? ''), { systemMessage: '🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact' });
  assert.equal(await runContextHook('stop', stop(transcript(home, 312000)), deps(home, jev(0.3, 0.2))), null);
});

test('below 100k Jev is not asked and only the size is saved', async () => {
  const home = setup();
  const calls: string[] = [];
  await runContextHook('stop', stop(transcript(home, 52000)), deps(home, jev(0.9, 0.9, calls)));
  assert.equal(calls.length, 0);
  assert.deepEqual(readState(home, 'sess-1'), { sessionId: 'sess-1', at: NOW.getTime(), size: 52000, judgment: null });
  assert.equal(logLines(home)[0].reason, 'below_min');
});

test('a running subagent counts as work in progress without asking Jev', async () => {
  const home = setup();
  const calls: string[] = [];
  await runContextHook('stop', stop(transcript(home, 312000), { background_tasks: [{ id: 'b1', type: 'shell' }, { id: 'b2', type: 'subagent' }] }), deps(home, jev(0.9, 0.9, calls)));
  assert.equal(calls.length, 0);
  assert.deepEqual(readState(home, 'sess-1')?.judgment, { phase: 'working', clear: false });
  const [log] = logLines(home);
  assert.equal(log.reason, 'background_tasks');
  assert.deepEqual(log.background, ['shell', 'subagent']);
});

test('a background shell or monitor alone does not stop the judgment', async () => {
  const home = setup();
  const calls: string[] = [];
  await runContextHook('stop', stop(transcript(home, 312000), { background_tasks: [{ id: 'b1', type: 'shell' }, { id: 'b2', type: 'monitor' }] }), deps(home, jev(0.9, 0.2, calls)));
  assert.equal(calls.length, 1);
  assert.deepEqual(readState(home, 'sess-1')?.judgment, { phase: 'unit_done', clear: false });
  assert.equal(logLines(home)[0].advice, 'compact');
});

test('a stop hook that is already continuing does nothing', async () => {
  const home = setup();
  const out = await runContextHook('stop', stop(transcript(home, 312000), { stop_hook_active: true }), deps(home, jev(0.9, 0.9)));
  assert.equal(out, null);
  assert.equal(readState(home, 'sess-1'), null);
});

test('without a key, or when Jev fails, the size is still saved without a judgment', async () => {
  const noKey = setup((c) => ({ ...c, keyFile: null }));
  const calls: string[] = [];
  await runContextHook('stop', stop(transcript(noKey, 312000)), deps(noKey, jev(0.9, 0.9, calls)));
  assert.equal(calls.length, 0);
  assert.equal(logLines(noKey)[0].reason, 'no_key');
  const broken = setup();
  await runContextHook('stop', stop(transcript(broken, 312000)), deps(broken, failing));
  assert.deepEqual(readState(broken, 'sess-1'), { sessionId: 'sess-1', at: NOW.getTime(), size: 312000, judgment: null });
  const [log] = logLines(broken);
  assert.equal(log.reason, 'jev_error');
  assert.match(log.jev.error, /^HTTP 500/);
});

test('a missing transcript saves an unknown size after waiting at most three seconds for it', async () => {
  const home = setup();
  const slept: number[] = [];
  await runContextHook('stop', stop(path.join(home, 'gone.jsonl')), deps(home, jev(0.9, 0.9), async (ms) => void slept.push(ms)));
  assert.deepEqual(readState(home, 'sess-1'), { sessionId: 'sess-1', at: NOW.getTime(), size: null, judgment: null });
  const [log] = logLines(home);
  assert.equal(log.reason, 'unknown_size');
  assert.equal(log.replySeen, false);
  assert.equal(log.waitedMs, 3000);
  assert.equal(slept.reduce((a, b) => a + b, 0), 3000);
});

test('when the reply is not in the transcript yet, the hook waits for it and judges the size that comes with it', async () => {
  const home = setup();
  const file = path.join(home, 'session.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: '로그인 화면 고쳐 줘' } })}\n`);
  let naps = 0;
  const sleep = async () => {
    naps += 1;
    if (naps === 3) transcript(home, 312000);
  };
  const calls: string[] = [];
  await runContextHook('stop', stop(file), deps(home, jev(0.9, 0.85, calls), sleep));
  assert.equal(naps, 3);
  assert.equal(calls.length, 1);
  assert.equal(readState(home, 'sess-1')?.size, 312000);
  const [log] = logLines(home);
  assert.equal(log.replySeen, true);
  assert.equal(log.waitedMs, 300);
  assert.equal(log.advice, 'clear');
});

test('switched off, nothing is read or written', async () => {
  const home = setup((c) => ({ ...c, context: { ...c.context, enabled: false } }));
  assert.equal(await runContextHook('stop', stop(transcript(home, 312000)), deps(home, jev(0.9, 0.9))), null);
  assert.equal(fs.existsSync(path.join(dataDir(home), 'state')), false);
  assert.equal(fs.existsSync(path.join(dataDir(home), 'log')), false);
});

test('session end removes the state file and logs why the session ended', async () => {
  const home = setup();
  writeState(home, { sessionId: 'sess-1', at: 1, size: 312000, judgment: null });
  const out = await runContextHook('session-end', JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionEnd', reason: 'clear' }), deps(home, jev(0.9, 0.9)));
  assert.equal(out, null);
  assert.equal(readState(home, 'sess-1'), null);
  const [log] = logLines(home);
  assert.equal(log.event, 'session_end');
  assert.equal(log.reason, 'clear');
});

function runEntry(args: string[], input: string, home: string) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/context/hook.ts', ...args], {
    cwd: REPO,
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TYPESAFE_API_KEY: '' },
  });
}

test('the entry exits 0 quietly on broken input and on an unknown event', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-ctx-entry-'));
  for (const [args, input] of [[['stop'], ''], [['stop'], 'not json'], [['session-end'], '{"session_id":'], [['nope'], stop('x')], [[], stop('x')]] as const) {
    const r = runEntry([...args], input, home);
    assert.equal(r.status, 0, `${args.join(' ')} ${input}`);
    assert.equal(r.stdout, '', `${args.join(' ')} ${input}`);
  }
});

test('a state that cannot be saved still leaves the log line of the Jev call', async () => {
  const home = setup();
  fs.writeFileSync(path.join(dataDir(home), 'state'), 'not a folder');
  const calls: string[] = [];
  await runContextHook('stop', stop(transcript(home, 312000)), deps(home, jev(0.9, 0.9, calls)));
  assert.equal(calls.length, 1);
  const [log] = logLines(home);
  assert.equal(log.reason, null);
  assert.deepEqual(log.judgment, { phase: 'unit_done', clear: true });
});

test('a request that contains the key is logged with the key replaced', async () => {
  const home = setup();
  const file = path.join(home, 'session.jsonl');
  const entries = [
    { type: 'user', isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: '내 키는 ts-test-key 야' } },
    { type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: REPLY }], usage: { input_tokens: 1, cache_read_input_tokens: 311999, cache_creation_input_tokens: 0 } } },
  ];
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  await runContextHook('stop', stop(file), deps(home, jev(0.9, 0.2)));
  const text = fs.readFileSync(path.join(dataDir(home), 'log', '2026-10.jsonl'), 'utf8');
  assert.equal(text.includes('ts-test-key'), false);
  assert.match(text, /내 키는 \[redacted\] 야/);
});
