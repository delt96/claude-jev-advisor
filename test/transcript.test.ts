import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextSize, parseLines, readTail, readTranscript, recentRequests, replyWritten, type Entry } from '../src/context/transcript.js';

const usage = (input: number, read: number, write: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 });
const assistant = (u: object, extra: Entry = {}, model = 'claude-opus-5-5'): Entry => ({ type: 'assistant', isSidechain: false, message: { model, usage: u }, ...extra });
const human = (content: unknown, kind = 'human'): Entry => ({ type: 'user', isSidechain: false, origin: { kind }, message: { role: 'user', content } });
const boundary: Entry = { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 400000, postTokens: 30000 } };

function tempFile(entries: Entry[]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cja-transcript-')), 'session.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

test('the size is the last main-chain reply: input plus cache reads plus cache writes', () => {
  const entries = [assistant(usage(5, 100, 10)), assistant(usage(2, 300000, 12000)), assistant(usage(1, 900000, 0), { isSidechain: true })];
  assert.equal(contextSize(entries), 312002);
});

test('synthetic replies are skipped', () => {
  assert.equal(contextSize([assistant(usage(1, 200000, 0)), assistant(usage(0, 0, 0), {}, '<synthetic>')]), 200001);
});

test('a compact boundary after the last reply means zero, and a reply after it counts again', () => {
  assert.equal(contextSize([assistant(usage(1, 400000, 0)), boundary]), 0);
  assert.equal(contextSize([assistant(usage(1, 400000, 0)), boundary, assistant(usage(3, 80000, 5000))]), 85003);
  assert.equal(contextSize([human('hi')]), null);
});

test('recent requests are the last three from a person, a channel or another session, oldest first, cut to 1000 characters', () => {
  const entries: Entry[] = [
    human('first'),
    human('second'),
    human('from the hub', 'channel'),
    human('a task finished', 'task-notification'),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } },
    { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
    human('from a peer session', 'peer'),
    human([{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }, { type: 'text', text: 'please' }]),
    human('x'.repeat(1500)),
    { ...human('a subagent prompt'), isSidechain: true },
    human('   '),
  ];
  assert.deepEqual(recentRequests(entries), ['from a peer session', 'look at this\nplease', 'x'.repeat(1000)]);
  assert.deepEqual(recentRequests(entries, 4), ['from the hub', 'from a peer session', 'look at this\nplease', 'x'.repeat(1000)]);
});

test('broken lines are skipped', () => {
  assert.deepEqual(parseLines('{"type":"user"}\nnot json\n[1]\n\n{"type":"assistant"}\n'), [{ type: 'user' }, { type: 'assistant' }]);
});

test('reading a tail drops the cut first line and says when it read the whole file', () => {
  const last = human('last');
  const file = tempFile([human('a'.repeat(200)), last]);
  const part = readTail(file, Buffer.byteLength(JSON.stringify(last)) + 11);
  assert.equal(part.whole, false);
  assert.deepEqual(part.entries, [last]);
  const whole = readTail(file, 1_000_000);
  assert.equal(whole.whole, true);
  assert.equal(whole.entries.length, 2);
});

test('readTranscript reads further back until it has three requests, up to its limit', () => {
  const file = tempFile([human('one'), human('two'), human('three'), ...Array.from({ length: 20 }, () => assistant(usage(1, 150000, 0)))]);
  assert.deepEqual(readTranscript(file, '', { start: 256, max: 1_000_000 }), { size: 150001, requests: ['one', 'two', 'three'], replySeen: true });
  const capped = readTranscript(file, '', { start: 256, max: 512 });
  assert.equal(capped.size, 150001);
  assert.ok(capped.requests.length < 3);
});

test('a last line of several megabytes (a pasted image) still leaves the size and requests readable', () => {
  const pasted = human([{ type: 'image', source: { type: 'base64', data: 'A'.repeat(3 * 1024 * 1024) } }, { type: 'text', text: 'see the image' }]);
  const file = tempFile([human('before'), assistant(usage(1, 250000, 0)), pasted]);
  assert.deepEqual(readTranscript(file), { size: 250001, requests: ['before', 'see the image'], replySeen: true });
});

const said = (text: string, extra: Entry = {}): Entry => ({ type: 'assistant', isSidechain: false, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, ...extra });

test('the reply counts as written when its last text block is in a main-chain entry after the last request', () => {
  assert.equal(replyWritten([human('fix it'), said('Fixed.')], 'Fixed.'), true);
  assert.equal(replyWritten([human('fix it'), said('  Fixed.\n')], 'Fixed.'), true);
  assert.equal(replyWritten([said('Fixed.'), human('again')], 'Fixed.'), false);
  assert.equal(replyWritten([human('fix it'), said('Fixed.', { isSidechain: true })], 'Fixed.'), false);
  assert.equal(replyWritten([human('fix it'), said('Working on it.')], 'Fixed.'), false);
  assert.equal(replyWritten([human('fix it')], ''), true);
  assert.equal(replyWritten([human('fix it'), said('First part.'), said('Second part.')], 'First part.\n\nSecond part.'), true);
  assert.equal(replyWritten([human('fix it'), said('First part.')], 'First part.\n\nSecond part.'), false);
});

test('readTranscript says whether the given reply is written yet', () => {
  const file = tempFile([human('fix it'), { ...said('Fixed.'), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed.' }], usage: usage(1, 260000, 0) } }]);
  assert.equal(readTranscript(file, 'Fixed.').replySeen, true);
  assert.equal(readTranscript(file, 'Something else.').replySeen, false);
});
