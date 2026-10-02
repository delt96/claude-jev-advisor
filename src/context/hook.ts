import os from 'node:os';
import { runContextHook } from './run.js';

async function main(): Promise<void> {
  const event = process.argv[2];
  if (event !== 'stop' && event !== 'session-end') return;
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const out = await runContextHook(event, raw, { home: os.homedir(), env: process.env, now: () => new Date() });
  if (out) process.stdout.write(out);
}

// Any failure must end quietly with exit code 0: a Stop hook that fails or exits 2 would hold up or block the turn.
main().catch(() => {});
