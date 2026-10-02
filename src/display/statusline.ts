import os from 'node:os';
import { runBeforeCommand, runStatusLine } from './statusline-run.js';

async function main(): Promise<void> {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  const out = await runStatusLine(raw, { home: os.homedir(), runBefore: (command, input) => runBeforeCommand(command, input) });
  if (out) process.stdout.write(out);
}

// A failing status line must print nothing rather than an error, and exit 0.
main().catch(() => {});
