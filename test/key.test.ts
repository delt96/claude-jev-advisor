import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkJevKey, promptForKey, saveJevKey, type KeyCheck, type KeyPrompt } from '../src/key.js';
import { readJevKey, type FetchFn } from '../src/jev.js';
import { savedKeyPath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-key-'));

function fakePrompt(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  const prompt: KeyPrompt = {
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? '';
    },
    say: (line) => {
      said.push(line);
    },
  };
  return { prompt, said, asked };
}

const reply = (status: number, body: string): FetchFn => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => body });

test('a saved key is read back through the key file and replaced on the next save', () => {
  const home = tempHome();
  const file = saveJevKey(home, 'ts-first');
  assert.equal(file, savedKeyPath(home));
  assert.equal(readJevKey({}, file), 'ts-first');
  saveJevKey(home, 'ts-second');
  assert.equal(readJevKey({}, file), 'ts-second');
});

test('a rejected key is asked again, and the key never appears in what is said', async () => {
  const { prompt, said, asked } = fakePrompt(['ts-bad', 'ts-good']);
  const checks: Record<string, KeyCheck> = { 'ts-bad': { status: 'rejected', detail: 'HTTP 401: invalid key [redacted]' }, 'ts-good': { status: 'ok' } };
  const key = await promptForKey(prompt, async (k) => checks[k]);
  assert.equal(key, 'ts-good');
  assert.equal(asked.length, 2);
  assert.equal(said.length, 1);
  assert.match(said[0], /did not work/);
  assert.equal(said.join('\n').includes('ts-bad'), false);
});

test('Enter skips, and surrounding spaces are trimmed', async () => {
  assert.equal(await promptForKey(fakePrompt(['   ']).prompt, async () => ({ status: 'ok' })), null);
  assert.equal(await promptForKey(fakePrompt(['  ts-key  ']).prompt, async () => ({ status: 'ok' })), 'ts-key');
});

test('a key that cannot be checked is kept, with a note', async () => {
  const { prompt, said } = fakePrompt(['ts-offline']);
  const key = await promptForKey(prompt, async () => ({ status: 'unchecked', detail: 'fetch failed' }));
  assert.equal(key, 'ts-offline');
  assert.match(said[0], /could not check/);
});

test('checking a key tells an accepted key from a rejected one and from a failed check', async () => {
  const good = JSON.stringify({ model: 'jev-1', answers: { ok: { type: 'noul', noul: 0.9 } } });
  assert.deepEqual(await checkJevKey('ts-k', reply(200, good)), { status: 'ok' });
  assert.equal((await checkJevKey('ts-k', reply(401, 'unauthorized'))).status, 'rejected');
  assert.equal((await checkJevKey('ts-k', reply(403, 'forbidden'))).status, 'rejected');
  assert.equal((await checkJevKey('ts-k', reply(503, 'busy'))).status, 'unchecked');
  assert.equal((await checkJevKey('ts-k', async () => { throw new Error('fetch failed'); })).status, 'unchecked');
});
