import fs from 'node:fs';
import path from 'node:path';
import { ICASE, runGit, type GitRunner } from './git.js';
import { BUILD_DIRS } from './targets.js';

export type RecoveryNote = { kind: 'untracked' | 'changed' | 'unmerged' | 'repository'; path?: string };
export type Recovery = { lift: 'git' } | { lift: 'copy'; copy: string } | { lift: null; note: RecoveryNote | null };

export const MAX_NAMED_PATHS = 30;
export const MAX_COPY_BYTES = 2 * 1024 * 1024;
export const MAX_CONTAINER_CHILDREN = 10;

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

function realKey(p: string): string | null {
  try {
    return key(fs.realpathSync.native(p));
  } catch {
    return null;
  }
}

function within(candidate: string, folder: string): boolean {
  return candidate === folder || candidate.startsWith(`${folder}\\`);
}

function isRegularFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

// Only real paths decide: a junction, a short name or a trailing dot can reach the file being deleted under another spelling.
function identicalCopy(file: string, named: string[], targets: string[]): string | null {
  const own = realKey(file);
  if (own === null) return null;
  const blocked = [own, ...targets.map((t) => realKey(t) ?? key(t)), ...targets.map(key)];
  for (const copy of named) {
    const real = realKey(copy);
    if (real === null || real === own || blocked.some((t) => within(real, t) || within(key(copy), t))) continue;
    if (isRegularFile(copy) && sameContent(file, copy)) return copy;
  }
  return null;
}

function gitRecovery(file: string, git: GitRunner): { inGit: boolean; note: RecoveryNote | null } | null {
  // Asked from the file's own folder with its bare name, so another spelling of the folder part cannot hide the file.
  const dir = win.dirname(file);
  const base = win.basename(file);
  const spec = `:(literal)${base}`;
  const listed = git(['-C', dir, 'ls-files', '-v', '-z', '--', spec], ICASE);
  if (listed.status !== 0) return null;
  const tags = listed.stdout.split('\0').filter((entry) => entry !== '').map((entry) => entry[0]);
  const tracked = tags.length > 0;
  // Assume-unchanged (lowercase) and skip-worktree (S) entries are never compared with the working file, so a clean status proves nothing.
  if (tracked && tags.every((tag) => tag === 'H')) {
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

const NOT_LIFTED: Recovery = { lift: null, note: null };

const entries = (stdout: string) => stdout.split('\0').filter((entry) => entry !== '');

function isFile(p: string): boolean {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function insideRecovery(dir: string, prefix: string, git: GitRunner): Recovery {
  const status = git(['-C', dir, 'status', '--porcelain', '-z', '--ignored', '--untracked-files=normal', '--ignore-submodules=none', '--', '.'], ICASE);
  if (status.status !== 0) return NOT_LIFTED;
  const list = entries(status.stdout);
  for (let i = 0; i < list.length; i++) {
    const code = list[i].slice(0, 2);
    const full = list[i].slice(3);
    if (/[RC]/.test(code)) i++;
    if (!full.startsWith(prefix)) return NOT_LIFTED;
    const rel = full.slice(prefix.length) || win.basename(dir);
    if (code === '!!') {
      if (!rel.split('/').some((segment) => BUILD_DIRS.has(segment.toLowerCase()))) return { lift: null, note: { kind: 'untracked', path: rel } };
      continue;
    }
    return { lift: null, note: { kind: code === '??' ? 'untracked' : 'changed', path: rel } };
  }
  // Assume-unchanged (lowercase) and skip-worktree (S) entries hide edits from status, so any tag but H keeps the folder.
  const tagged = git(['-C', dir, 'ls-files', '-v', '-s', '-z', '--', '.'], ICASE);
  if (tagged.status !== 0) return NOT_LIFTED;
  const listed = entries(tagged.stdout).map((entry) => ({ tag: entry[0], mode: entry.slice(2, 8), path: entry.slice(entry.indexOf('\t') + 1) }));
  // A gitlink is judged by status only when dirty, and its inner repository can hold commits or edits nothing else has.
  const inner = listed.find((entry) => entry.mode === '160000');
  if (inner !== undefined) return { lift: null, note: { kind: 'repository', path: inner.path } };
  const hidden = listed.find((entry) => entry.tag !== 'H');
  if (hidden !== undefined) return { lift: null, note: { kind: 'changed', path: hidden.path } };
  return { lift: 'git' };
}

function worktreeRecovery(dir: string, git: GitRunner): Recovery {
  const head = git(['-C', dir, 'symbolic-ref', '-q', 'HEAD']);
  if (head.status !== 0 && head.status !== 1) return NOT_LIFTED;
  const own = head.status === 0 ? head.stdout.trim() : '';
  const refs = git(['-C', dir, 'for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (refs.status !== 0) return NOT_LIFTED;
  const elsewhere = refs.stdout.split('\n').some((ref) => ref.trim() !== '' && ref.trim() !== own);
  return elsewhere ? { lift: 'git' } : { lift: null, note: { kind: 'unmerged' } };
}

function containerRecovery(dir: string, git: GitRunner): Recovery {
  let children: fs.Dirent[];
  try {
    children = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return NOT_LIFTED;
  }
  if (children.length > MAX_CONTAINER_CHILDREN) return NOT_LIFTED;
  for (const child of children) {
    const full = win.join(dir, child.name);
    if (!child.isDirectory()) return { lift: null, note: { kind: 'untracked', path: child.name } };
    let empty: boolean;
    try {
      empty = fs.readdirSync(full).length === 0;
    } catch {
      return NOT_LIFTED;
    }
    if (empty) continue;
    const inner = isFile(win.join(full, '.git')) ? folderRecovery(full, git) : { lift: null, note: { kind: 'untracked', path: '' } } as Recovery;
    if (inner.lift === 'git') continue;
    if (inner.lift === null && inner.note !== null) return { lift: null, note: { ...inner.note, path: `${child.name}${inner.note.path ? `/${inner.note.path}` : ''}` } };
    return NOT_LIFTED;
  }
  return { lift: 'git' };
}

export function folderRecovery(dir: string, git: GitRunner = runGit): Recovery {
  try {
    if (isDirectory(win.join(dir, '.git'))) return { lift: null, note: { kind: 'repository' } };
    const probe = git(['-C', dir, 'rev-parse', '--is-inside-work-tree', '--show-prefix']);
    if (probe.status === 0) {
      const [inside, prefix = ''] = probe.stdout.split('\n');
      if (inside !== 'true') return NOT_LIFTED;
      const viaStatus = insideRecovery(dir, prefix.trim(), git);
      if (viaStatus.lift !== 'git' || !isFile(win.join(dir, '.git'))) return viaStatus;
      return worktreeRecovery(dir, git);
    }
    if (probe.status !== 128 || !/not a git repository/i.test(probe.stderr) || isFile(win.join(dir, '.git'))) return NOT_LIFTED;
    return containerRecovery(dir, git);
  } catch {
    return NOT_LIFTED;
  }
}

export const MAX_RECOVER_TARGETS = 10;

// The clock is also checked before every git call, so a target that starts just inside the budget runs at most one call past it.
export function recoverTargets(paths: string[], command: string, cwd: string, home: string, outOfTime: () => boolean, git: GitRunner = runGit): Recovery[] {
  const named = namedPaths(command, cwd, home);
  const limited: GitRunner = (args, env) => (outOfTime() ? { status: null, stdout: '', stderr: '' } : git(args, env));
  return paths.map((target) => {
    if (outOfTime()) return NOT_LIFTED;
    const result = isDirectory(target) ? folderRecovery(target, limited) : fileRecovery(target, named, paths, limited);
    return result.lift === null && outOfTime() ? NOT_LIFTED : result;
  });
}
