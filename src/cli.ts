import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalPrompt } from './cli/prompt.js';
import { runCli } from './cli/run.js';

runCli(process.argv.slice(2), {
  home: os.homedir(),
  distDir: path.dirname(fileURLToPath(import.meta.url)),
  platform: process.platform,
  now: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  prompt: terminalPrompt(),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`claude-jev-advisor: ${(err as Error)?.message ?? err}`);
    process.exitCode = 1;
  },
);
