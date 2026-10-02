import fs from 'node:fs';
import path from 'node:path';
import { callJev, type FetchFn, type JevRequest } from './jev.js';
import { savedKeyPath } from './paths.js';

export type KeyPrompt = { ask(question: string): Promise<string>; say(line: string): void };
export type KeyCheck = { status: 'ok' } | { status: 'rejected'; detail: string } | { status: 'unchecked'; detail: string };

const CHECK_REQUEST: JevRequest = {
  state: { text: 'hello' },
  questions: { ok: { type: 'noul', instructions: 'Is `text` a greeting?', criteria: { true: 'It is a greeting.', false: 'It is not a greeting.' } } },
};
const REJECTED = /^HTTP 40[13]\b/;

export async function checkJevKey(key: string, fetchFn?: FetchFn): Promise<KeyCheck> {
  const result = await callJev(CHECK_REQUEST, { key, fetchFn });
  if (!('error' in result)) return { status: 'ok' };
  return REJECTED.test(result.error) ? { status: 'rejected', detail: result.error } : { status: 'unchecked', detail: result.error };
}

export function saveJevKey(home: string, key: string): string {
  const file = savedKeyPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `TYPESAFE_API_KEY=${key}${String.fromCharCode(10)}`, { mode: 0o600 });
  return file;
}

export async function promptForKey(prompt: KeyPrompt, check: (key: string) => Promise<KeyCheck>): Promise<string | null> {
  for (;;) {
    const key = (await prompt.ask('TypeSafe API key (Enter to skip): ')).trim();
    if (!key) return null;
    const result = await check(key);
    if (result.status === 'ok') return key;
    if (result.status === 'unchecked') {
      prompt.say(`Saved without a check: could not check the key (${result.detail}).`);
      return key;
    }
    prompt.say(`That key did not work (${result.detail}). Try again, or press Enter to skip.`);
  }
}
