import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli/run.js';

process.exitCode = runCli(process.argv.slice(2), {
  home: os.homedir(),
  distDir: path.dirname(fileURLToPath(import.meta.url)),
  platform: process.platform,
  now: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
