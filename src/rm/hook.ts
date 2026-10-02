import os from 'node:os';
import { realProbe } from './guard.js';
import { runRmHook } from './run.js';

async function main(): Promise<void> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const out = runRmHook(raw, { home: os.homedir(), env: process.env, tmpdir: os.tmpdir(), cwd: process.cwd(), probe: realProbe });
  if (out) process.stdout.write(out);
}

// Any failure must fall through to Claude Code's normal handling, never block the Bash call.
main().catch(() => {});
