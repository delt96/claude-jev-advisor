import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const win = path.win32;
const BUILD_DIRS = new Set(['target', 'build', 'dist', 'out', 'node_modules', 'coverage', '__pycache__', '.pytest_cache', '.gradle', '.next', '.nuxt', '.turbo', '.cache', 'bin', 'obj']);
const MAX_LISTED = 3;

export type Probe = { exists(p: string): boolean; isIgnored(p: string): boolean };
export type RmTarget = { shown: string; path: string | null };
export type RmDecision = { decision: 'ask' | 'deny'; reason: string; targets?: RmTarget[] };
export type Shell = 'bash' | 'powershell' | 'cmd';
export type ReadCtx = { cwd: string | null; home: string; tmpdirs: string[]; env: Record<string, string | undefined>; probe: Probe };
export type ShellCall = { name: string; args: (string | null)[]; cwd: string | null; raw: string };
export type ReadResult = { deny: string | null; targets: RmTarget[]; failed: string[]; shells: ShellCall[] };
export type Resolved = { path: string } | { unc: string } | { unresolvable: string };

export const emptyRead = (): ReadResult => ({ deny: null, targets: [], failed: [], shells: [] });

export function isInside(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase().replace(/\\+$/, '');
  return c.startsWith(`${p}\\`);
}

function segments(p: string): string[] {
  return p.toLowerCase().split('\\');
}

export function judgePath(p: string, pattern: string | null, ctx: Pick<ReadCtx, 'tmpdirs' | 'probe'>): RmTarget | null {
  const shown = pattern === null ? p : `${p.replace(/\\$/, '')}\\${pattern}`;
  const narrowPattern = pattern !== null && !/^[*?.]+$/.test(pattern);
  if (ctx.tmpdirs.some((t) => isInside(p, t) || (narrowPattern && p.toLowerCase() === t.toLowerCase().replace(/\\+$/, '')))) return null;
  if (segments(p).includes('.superpowers')) return null;
  if (pattern === null && !ctx.probe.exists(p)) return null;
  if (segments(p).some((s) => BUILD_DIRS.has(s)) && ctx.probe.isIgnored(p)) return null;
  return { shown, path: pattern === null ? p : null };
}

export function splitPattern(value: string, wildcard: RegExp): { dir: string; pattern: string } | null {
  const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (wildcard.test(value.slice(0, Math.max(cut, 0)))) return null;
  return { dir: value.slice(0, Math.max(cut, 0)) || '.', pattern: value.slice(cut + 1) };
}

// A name right under a root keeps the root as its folder (`C:\*.log`, `/*.log`), and `D:*.log` keeps its drive so
// the drive-relative path is refused instead of being read in the current folder.
export function splitWindowsPattern(value: string, wildcard: RegExp): { dir: string; pattern: string } | null {
  const drive = /^([A-Za-z]:)([^\\/]*)$/.exec(value);
  if (drive) return { dir: drive[1], pattern: drive[2] };
  const split = splitPattern(value, wildcard);
  if (split === null) return null;
  const root = /^((?:[A-Za-z]:)?[\\/])[^\\/]*$/.exec(value);
  return root ? { dir: root[1], pattern: split.pattern } : split;
}

// Windows path rules shared by cmd and PowerShell; Git Bash spellings such as /c/... are read in guard.ts.
export function resolveWindowsPath(value: string, cwd: string | null, home: string | null): Resolved {
  if (/^(?:\\\\|\/\/)/.test(value)) return { unc: value };
  if (home !== null && /^~(?:[\\/]|$)/.test(value)) return { path: win.resolve(home, value.slice(2) || '.') };
  if (/^[A-Za-z]:[\\/]/.test(value)) return { path: win.normalize(value) };
  if (/^[A-Za-z]:/.test(value)) return { unresolvable: `a path relative to another drive's folder (${value})` };
  if (cwd === null) return { unresolvable: `a path relative to a folder that cannot be worked out (${value})` };
  return { path: win.resolve(cwd, value) };
}

const EXAMPLES: Record<Shell, { what: string; rules: string; example: string; then: string }> = {
  bash: {
    what: 'this rm',
    rules: 'no shell variables, command substitutions, xargs, brace expansion or wildcards in folder names, and no cd to such a path before it',
    example: 'rm -f "C:/full/path/file.txt"',
    then: 'rm the printed paths',
  },
  powershell: {
    what: 'this PowerShell command',
    rules: 'no variables other than $env:TEMP, $env:TMP, $env:USERPROFILE, $HOME and $PWD, no expressions, script blocks or pipeline input, no wildcards in folder names, and no Set-Location to such a path before it',
    example: 'Remove-Item -LiteralPath "C:\\full\\path\\file.txt"',
    then: 'delete the printed paths',
  },
  cmd: {
    what: 'this del or rd',
    rules: 'no variables other than %TEMP%, %TMP%, %USERPROFILE% and %CD%, no wildcards in folder names, and no cd to such a path before it',
    example: 'del /q "C:\\full\\path\\file.txt"',
    then: 'delete the printed paths',
  },
};

export function denyReason(shell: Shell, why: string): string {
  const { what, rules, example, then } = EXAMPLES[shell];
  return `rm-guard could not work out what ${what} would delete (${why}). Rewrite it with literal paths: ${rules}. Example: ${example}. If you need a variable or a listing to find the paths, run that on its own first, then ${then}.`;
}

function listed(targets: RmTarget[]): string {
  const names = targets.slice(0, MAX_LISTED).map((t) => t.shown).join(', ');
  return targets.length > MAX_LISTED ? `${names} 외 ${targets.length - MAX_LISTED}개` : names;
}

export const UNREAD_TARGET = '(분석하지 못한 명령)';

export function decisionOf({ deny, targets, failed }: ReadResult): RmDecision | null {
  if (deny !== null) return { decision: 'deny', reason: deny };
  if (failed.length) {
    const note = `삭제 명령을 분석하지 못함: ${failed[0]}`;
    // A target without a path keeps Jev from lifting an ask that covers a deletion nobody could read.
    return { decision: 'ask', reason: targets.length ? `실제 파일 삭제: ${listed(targets)} · ${note}` : note, targets: [...targets, { shown: UNREAD_TARGET, path: null }] };
  }
  if (!targets.length) return null;
  return { decision: 'ask', reason: `실제 파일 삭제: ${listed(targets)}`, targets };
}

export function hookOutput({ decision, reason }: RmDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

export const realProbe: Probe = {
  exists(p) {
    try { fs.lstatSync(p); return true; } catch { return false; }
  },
  isIgnored(p) {
    const r = spawnSync('git', ['-C', win.dirname(p), 'check-ignore', '-q', '--', p], { timeout: 3000, windowsHide: true });
    return r.status === 0;
  },
};
