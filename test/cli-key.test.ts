import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/run.js';
import { readConfig } from '../src/config.js';
import { readJevKey } from '../src/jev.js';
import type { KeyCheck } from '../src/key.js';
import { savedKeyPath } from '../src/paths.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cja-ckey-'));

async function cli(argv: string[], opts: { home?: string; answers?: string[]; interactive?: boolean; checks?: Record<string, KeyCheck> } = {}) {
  const home = opts.home ?? tempHome();
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const io: CliIo = {
    home,
    distDir: 'C:/n/@delt/claude-jev-advisor/dist',
    platform: 'win32',
    now: () => new Date(2026, 9, 2, 23, 0, 0),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    prompt: opts.interactive === false ? undefined : { ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, say: (l) => out.push(l) },
    checkKey: async (key) => opts.checks?.[key] ?? { status: 'ok' },
  };
  const code = await runCli(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n'), home, asked };
}

test('install asks for a missing key, checks it and saves it without printing it', async () => {
  const r = await cli(['install', 'context'], { answers: ['ts-secret-key'] });
  assert.equal(r.code, 0);
  assert.equal(r.asked.length, 1);
  assert.equal(readConfig(r.home).keyFile, savedKeyPath(r.home));
  assert.equal(readJevKey({}, savedKeyPath(r.home)), 'ts-secret-key');
  assert.match(r.out, /Saved the key to/);
  assert.equal(r.out.includes('ts-secret-key'), false);
});

test('a rejected key is asked again before anything is saved', async () => {
  const r = await cli(['install', 'context'], { answers: ['ts-bad', 'ts-good'], checks: { 'ts-bad': { status: 'rejected', detail: 'HTTP 401: invalid key [redacted]' } } });
  assert.equal(r.asked.length, 2);
  assert.equal(readJevKey({}, savedKeyPath(r.home)), 'ts-good');
  assert.equal(r.out.includes('ts-bad'), false);
});

test('Enter skips: nothing is saved and the way to add a key later is shown', async () => {
  const r = await cli(['install', 'context'], { answers: [''] });
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(savedKeyPath(r.home)), false);
  assert.equal(readConfig(r.home).keyFile, null);
  assert.match(r.out, /claude-jev-advisor key/);
});

test('install does not ask when a key file is given, when only rm is installed, or without a terminal', async () => {
  const keyFile = path.join(tempHome(), 'my-key.env');
  fs.writeFileSync(keyFile, 'TYPESAFE_API_KEY=ts-from-file\n');
  assert.equal((await cli(['install', 'context', '--key-file', keyFile], { answers: ['x'] })).asked.length, 0);
  assert.equal((await cli(['install', 'rm'], { answers: ['x'] })).asked.length, 0);
  const plain = await cli(['install', 'context'], { interactive: false });
  assert.equal(plain.asked.length, 0);
  assert.match(plain.out, /No TypeSafe API key yet/);
});

test('installing again with a saved key does not ask again', async () => {
  const first = await cli(['install', 'context'], { answers: ['ts-key'] });
  const again = await cli(['install', 'context'], { home: first.home, answers: ['x'] });
  assert.equal(again.asked.length, 0);
});

test('the key command replaces the key, and needs a terminal', async () => {
  const first = await cli(['install', 'context'], { answers: ['ts-old'] });
  const r = await cli(['key'], { home: first.home, answers: ['ts-new'] });
  assert.equal(r.code, 0);
  assert.equal(readJevKey({}, savedKeyPath(first.home)), 'ts-new');
  const plain = await cli(['key'], { interactive: false });
  assert.equal(plain.code, 1);
  assert.match(plain.err, /interactive terminal/);
});

test('uninstall keeps the saved key and says where it is', async () => {
  const first = await cli(['install', 'context'], { answers: ['ts-key'] });
  const r = await cli(['uninstall', 'context'], { home: first.home });
  assert.match(r.out, /kept your saved TypeSafe key/);
  assert.equal(fs.existsSync(savedKeyPath(first.home)), true);
});
