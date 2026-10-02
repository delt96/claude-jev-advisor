import fs from 'node:fs';
import path from 'node:path';
import { parseState, type ContextState } from '../display/line.js';
import { logDir, stateDir } from '../paths.js';

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const RENAME_ATTEMPTS = 3;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function statePath(home: string, sessionId: string): string | null {
  return SAFE_SESSION_ID.test(sessionId) ? path.join(stateDir(home), `${sessionId}.json`) : null;
}

export function writeState(home: string, state: ContextState): void {
  const file = statePath(home, state.sessionId);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state));
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(temp, file);
        return;
      } catch (err) {
        // Windows briefly locks a file that another process (the mod, an antivirus) is reading; a short retry usually gets through.
        if (attempt >= RENAME_ATTEMPTS || !RETRYABLE_RENAME.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
        pause(20 * attempt);
      }
    }
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export function readState(home: string, sessionId: string): ContextState | null {
  const file = statePath(home, sessionId);
  if (!file) return null;
  try {
    return parseState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function removeState(home: string, sessionId: string): void {
  const file = statePath(home, sessionId);
  if (file) fs.rmSync(file, { force: true });
}

export function logFile(home: string, now: Date): string {
  return path.join(logDir(home), `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`);
}

export function appendLog(home: string, now: Date, record: Record<string, unknown>): void {
  const file = logFile(home, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: now.toISOString(), ...record })}\n`);
}
