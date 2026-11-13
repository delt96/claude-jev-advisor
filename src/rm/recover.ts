import fs from 'node:fs';
import path from 'node:path';
import { ICASE, runGit, type GitRunner } from './git.js';

export type RecoveryNote = { kind: 'untracked' | 'changed' | 'unmerged' | 'repository'; path?: string };
export type Recovery = { lift: 'git' } | { lift: 'copy'; copy: string } | { lift: null; note: RecoveryNote | null };

export const MAX_NAMED_PATHS = 30;
export const MAX_COPY_BYTES = 2 * 1024 * 1024;

const win = path.win32;
const WORD = /"([^"]*)"|'([^']*)'|([^\s;|&()<>"']+)/g;
const NOT_LITERAL = /[$%*?`]|:\/\//;

function resolved(word: string, cwd: string, home: string): string | null {
  if (!/[\\/]/.test(word) || NOT_LITERAL.test(word) || /^(?:\\\\|\/\/)/.test(word)) return null;
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(word);
  if (drive) return win.normalize(`${drive[1].toUpperCase()}:\\${drive[2] ?? ''}`);
  if (/^~[\\/]/.test(word)) return win.join(home, word.slice(2));
  return win.resolve(cwd, word);
}

export function namedPaths(command: string, cwd: string, home: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const match of command.matchAll(WORD)) {
    const full = resolved(match[1] ?? match[2] ?? match[3] ?? '', cwd, home);
    if (full === null || seen.has(full.toLowerCase())) continue;
    seen.add(full.toLowerCase());
    found.push(full);
    if (found.length >= MAX_NAMED_PATHS) break;
  }
  return found;
}

const withoutCarriageReturns = (data: Buffer) => data.toString('latin1').replace(/\r\n/g, '\n');

export function sameContent(a: string, b: string): boolean {
  try {
    const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
    if (!sa.isFile() || !sb.isFile() || sa.size > MAX_COPY_BYTES || sb.size > MAX_COPY_BYTES) return false;
    return withoutCarriageReturns(fs.readFileSync(a)) === withoutCarriageReturns(fs.readFileSync(b));
  } catch {
    return false;
  }
}

const key = (p: string) => win.normalize(p.replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();

function insideTarget(candidate: string, targets: string[]): boolean {
  const c = key(candidate);
  return targets.some((t) => {
    const k = key(t);
    return c === k || c.startsWith(`${k}\\`);
  });
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function identicalCopy(file: string, named: string[], targets: string[]): string | null {
  for (const copy of named) {
    if (key(copy) === key(file) || insideTarget(copy, targets)) continue;
    if (isRegularFile(copy) && sameContent(file, copy)) return copy;
  }
  return null;
}

function gitRecovery(file: string, git: GitRunner): { inGit: boolean; note: RecoveryNote | null } | null {
  // Asked from the file's own folder with its bare name, so another spelling of the folder part cannot hide the file.
  const dir = win.dirname(file);
  const base = win.basename(file);
  const spec = `:(literal)${base}`;
  const listed = git(['-C', dir, 'ls-files', '-z', '--', spec], ICASE);
  if (listed.status !== 0) return null;
  const tracked = listed.stdout !== '';
  if (tracked) {
    const state = git(['-C', dir, 'status', '--porcelain', '-z', '--ignored', '--', spec], ICASE);
    if (state.status === 0 && state.stdout === '') return { inGit: true, note: null };
  }
  const note: RecoveryNote = { kind: tracked ? 'changed' : 'untracked', path: base };
  const hashed = git(['-C', dir, 'hash-object', '--', base]);
  const sha = hashed.stdout.trim();
  if (hashed.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { inGit: false, note };
  const found = git(['-C', dir, 'log', '--all', `--find-object=${sha}`, '-1', '--format=%H']);
  return { inGit: found.status === 0 && found.stdout.trim() !== '', note };
}

export function fileRecovery(file: string, named: string[], targets: string[], git: GitRunner = runGit): Recovery {
  const viaGit = gitRecovery(file, git);
  if (viaGit?.inGit) return { lift: 'git' };
  const copy = identicalCopy(file, named, targets);
  if (copy !== null) return { lift: 'copy', copy };
  return { lift: null, note: viaGit?.note ?? null };
}
