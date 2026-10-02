import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from '../config.js';
import { readState } from '../context/files.js';
import { statusLineBeforePath } from '../paths.js';
import { adviceLine, usableJudgment } from './line.js';

export type Shell = { file: string; args: string[] };
export type StatusLineDeps = { home: string; runBefore: (command: string, input: string) => Promise<string> };

export const BEFORE_TIMEOUT_MS = 2000;
const DEFAULT_GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function findGitBash(env: Record<string, string | undefined>, exists: (file: string) => boolean): string | null {
  const given = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (given && exists(given)) return given;
  const candidates: string[] = [];
  for (const dir of (env.PATH ?? env.Path ?? '').split(';').filter(Boolean)) {
    if (!exists(path.win32.join(dir, 'git.exe'))) continue;
    const parent = path.win32.dirname(dir);
    const root = path.win32.basename(parent).toLowerCase() === 'mingw64' ? path.win32.dirname(parent) : parent;
    candidates.push(path.win32.join(root, 'bin', 'bash.exe'));
  }
  candidates.push(DEFAULT_GIT_BASH);
  return candidates.find(exists) ?? null;
}

// Claude Code runs a status line command through Git Bash on Windows when it is installed, and through PowerShell
// otherwise; the user's command was written for that shell, not for cmd.exe.
export function statusLineShell(platform: NodeJS.Platform, env: Record<string, string | undefined>, exists: (file: string) => boolean): Shell {
  if (platform !== 'win32') return { file: '/bin/sh', args: ['-c'] };
  const bash = findGitBash(env, exists);
  return bash ? { file: bash, args: ['-c'] } : { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command'] };
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

export function previousStatusLine(home: string): { command: string } | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(statusLineBeforePath(home), 'utf8'));
    return isRecord(value) && typeof value.command === 'string' ? { command: value.command } : null;
  } catch {
    return null;
  }
}

export function runBeforeCommand(
  command: string,
  input: string,
  shell: Shell = statusLineShell(process.platform, process.env, fs.existsSync),
  timeoutMs = BEFORE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(shell.file, [...shell.args, command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    let settled = false;
    const settle = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      // Killing only the shell would leave its children holding the output pipe, and the line would wait for them.
      killTree(child.pid);
      child.stdout?.destroy();
      child.unref();
      settle('');
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    child.on('error', () => settle(''));
    child.on('close', (code) => settle(code === 0 ? out : ''));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
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

export async function runStatusLine(raw: string, deps: StatusLineDeps): Promise<string> {
  const before = previousStatusLine(deps.home);
  const userLine = before ? (await deps.runBefore(before.command, raw)).replace(/\s+$/, '') : '';
  return [userLine, ourLine(raw, deps.home)].filter(Boolean).join(' ');
}
