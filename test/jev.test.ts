import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JEV_URL, callJev, readJevKey, type FetchFn, type JevRequest } from '../src/jev.js';

const REQUEST: JevRequest = {
  state: { note: 'hello' },
  questions: { q: { type: 'noul', instructions: 'Is `note` a greeting?', criteria: { true: 'It is.', false: 'It is not.' } } },
};

function reply(status: number, body: string, headers: Record<string, string> = {}): FetchFn {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  });
}

test('the key comes from TYPESAFE_API_KEY first, then the key file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-jev-'));
  const file = path.join(dir, 'jev-key.env');
  fs.writeFileSync(file, '\uFEFFOTHER=1\r\nTYPESAFE_API_KEY="ts-file-key"\r\n');
  assert.equal(readJevKey({ TYPESAFE_API_KEY: 'ts-env-key' }, file), 'ts-env-key');
  assert.equal(readJevKey({}, file), 'ts-file-key');
  assert.equal(readJevKey({ TYPESAFE_API_KEY: '' }, file), 'ts-file-key');
  assert.equal(readJevKey({ TYPESAFE_API_KEY: '   ' }, file), 'ts-file-key');
  assert.equal(readJevKey({}, null), null);
  assert.equal(readJevKey({}, path.join(dir, 'missing.env')), null);
  fs.writeFileSync(file, 'OTHER=1\n');
  assert.equal(readJevKey({}, file), null);
});

test('a good reply gives the noul probabilities, the model, the request id and the time', async () => {
  let sent = null as { url: string; init: Parameters<FetchFn>[1] } | null;
  const fetchFn: FetchFn = async (url, init) => {
    sent = { url, init };
    return reply(200, JSON.stringify({ model: 'jev-1', answers: { q: { type: 'noul', noul: 0.91 }, other: { type: 'choice' } } }), { 'request-id': 'req-1' })(url, init);
  };
  let t = 1000;
  const r = await callJev(REQUEST, { key: 'ts-secret', fetchFn, now: () => (t += 250) });
  assert.deepEqual(r, { answers: { q: 0.91 }, model: 'jev-1', requestId: 'req-1', ms: 250 });
  assert.equal(sent?.url, JEV_URL);
  assert.equal(sent?.init.headers.Authorization, 'Bearer ts-secret');
  assert.deepEqual(JSON.parse(sent?.init.body ?? ''), { model: 'jev-latest', ...REQUEST });
});

test('odd reply shapes give the numbers that are there and never throw', async () => {
  const cases: [string, Record<string, number>][] = [
    ['{}', {}],
    ['{"answers": null}', {}],
    ['{"answers": {"q": null, "r": {"noul": "0.9"}, "s": {"noul": 0.4}}}', { s: 0.4 }],
  ];
  for (const [body, answers] of cases) {
    const r = await callJev(REQUEST, { key: 'k', fetchFn: reply(200, body) });
    assert.ok('answers' in r, body);
    assert.deepEqual(r.answers, answers, body);
  }
  assert.ok('error' in (await callJev(REQUEST, { key: 'k', fetchFn: reply(200, 'null') })));
});

test('an HTTP error, a bad body and a failed fetch become errors that never contain the key', async () => {
  const http = await callJev(REQUEST, { key: 'ts-secret', fetchFn: reply(401, 'unauthorized', { 'x-request-id': 'req-2' }) });
  assert.ok('error' in http);
  assert.match(http.error, /^HTTP 401: unauthorized/);
  assert.equal(http.requestId, 'req-2');
  const bad = await callJev(REQUEST, { key: 'ts-secret', fetchFn: reply(200, 'not json') });
  assert.ok('error' in bad);
  const thrown = await callJev(REQUEST, { key: 'ts-secret', fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND api.typesafe.ai'); } });
  assert.ok('error' in thrown);
  assert.match(thrown.error, /ENOTFOUND/);
  for (const r of [http, bad, thrown]) assert.equal(JSON.stringify(r).includes('ts-secret'), false);
});

test('the key is blanked out of an error body that echoes it', async () => {
  const r = await callJev(REQUEST, { key: 'ts-secret', fetchFn: reply(401, 'invalid key ts-secret') });
  assert.ok('error' in r);
  assert.equal(r.error, 'HTTP 401: invalid key [redacted]');
});

test('a reply slower than the time limit is cut off', async () => {
  const hanging: FetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const started = Date.now();
  const r = await callJev(REQUEST, { key: 'k', fetchFn: hanging, timeoutMs: 50 });
  assert.ok('error' in r);
  assert.match(r.error, /did not answer within 50 ms/);
  assert.ok(Date.now() - started < 2000);
});

test('a fetch that ignores the abort and never settles still ends at the limit', async () => {
  const stuck: FetchFn = () => new Promise(() => {});
  const started = Date.now();
  const r = await callJev(REQUEST, { key: 'k', fetchFn: stuck, timeoutMs: 50 });
  assert.ok('error' in r);
  assert.match(r.error, /did not answer within 50 ms/);
  assert.ok(Date.now() - started < 2000);
});
