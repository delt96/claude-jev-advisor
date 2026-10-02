import path from 'node:path';
import { readConfig } from '../config.js';
import { decide, hookOutput, type Probe } from './guard.js';

export type RmHookDeps = { home: string; env: Record<string, string | undefined>; tmpdir: string; cwd: string; probe: Probe };

type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };

export function runRmHook(raw: string, deps: RmHookDeps): string | null {
  if (!readConfig(deps.home).rm.enabled) return null;
  const input = JSON.parse(raw) as HookInput | null;
  if (typeof input !== 'object' || input === null) return null;
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string') return null;
  const tmpdirs = [...new Set([deps.tmpdir, deps.env.TEMP, deps.env.TMP].filter((t): t is string => Boolean(t)).map((t) => path.win32.resolve(t)))];
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : deps.cwd;
  const result = decide({ command, cwd, home: deps.home, tmpdirs, env: deps.env, probe: deps.probe });
  return result ? hookOutput(result) : null;
}
