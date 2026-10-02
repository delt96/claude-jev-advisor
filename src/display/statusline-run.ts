import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readConfig } from '../config.js';
import { readState } from '../context/files.js';
import { statusLineBeforePath } from '../paths.js';
import { adviceLine, usableJudgment } from './line.js';

export type StatusLineDeps = { home: string; runBefore: (command: string, input: string) => string };

const BEFORE_TIMEOUT_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function previousStatusLine(home: string): { command: string } | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statusLineBeforePath(home), 'utf8'));
    return isRecord(value) && typeof value.command === 'string' ? { command: value.command } : null;
  } catch {
    return null;
  }
}

export function runBeforeCommand(command: string, input: string): string {
  const r = spawnSync(command, { shell: true, input, encoding: 'utf8', timeout: BEFORE_TIMEOUT_MS, windowsHide: true });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : '';
}

function ourLine(raw: string, home: string): string {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return '';
  }
  const config = readConfig(home);
  if (!isRecord(input) || typeof input.session_id !== 'string' || !config.context.enabled || config.display !== 'statusline') return '';
  const window = isRecord(input.context_window) ? input.context_window : {};
  const size = typeof window.total_input_tokens === 'number' && window.total_input_tokens > 0 ? window.total_input_tokens : null;
  const judgment = usableJudgment(readState(home, input.session_id), size, 0);
  return adviceLine({ size, threshold: null, judgment, config });
}

export function runStatusLine(raw: string, deps: StatusLineDeps): string {
  const before = previousStatusLine(deps.home);
  const parts = [before ? deps.runBefore(before.command, raw).replace(/\s+$/, '') : '', ourLine(raw, deps.home)];
  return parts.filter(Boolean).join(' ');
}
