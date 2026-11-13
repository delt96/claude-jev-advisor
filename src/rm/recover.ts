import fs from 'node:fs';
import path from 'node:path';
import { ICASE, runGit, type GitRunner } from './git.js';
import { BUILD_DIRS } from './targets.js';

export type RecoveryNote = { kind: 'untracked' | 'changed' | 'unmerged' | 'repository'; path?: string };
export type Recovery = { lift: 'git' } | { lift: 'copy'; copy: string } | { lift: null; note: RecoveryNote | null };

const MAX_NAMED_PATHS = 30;
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

const DELETE_NAMES = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'remove-item']);
const READ_NAMES = new Set(['diff', 'fc', 'cmp', 'cat', 'type', 'get-content', 'gc', 'compare-object', 'get-filehash', 'sha256sum', 'md5sum']);
const POWERSHELL_COPY_NAMES = new Set(['copy', 'copy-item', 'cpi']);
// Only characters whose meaning is the same in Git Bash and PowerShell, so the split below reads the command as both
// shells do. Everything else (subexpressions, comments, escapes, redirects, curly quotes, en dashes) gives no candidates.
const PLAIN_COMMAND = /^[\p{L}\p{N}\p{M} \t\r\n._\-:\\/~'";&|]*$/u;
const ESCAPED_QUOTE_OR_LONE_CR = /\\["']|\r(?!\n)/;

function splitStatements(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote !== null) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    const doubled = command.slice(i, i + 2);
    if (doubled === '&&' || doubled === '||' || c === ';' || c === '|' || c === '\n' || c === '\r' || c === '&') {
      out.push(current);
      current = '';
      if (doubled === '&&' || doubled === '||') i++;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

const SLASH_OPTION = /^\/[A-Za-z?]$/;

function operandPath(text: string, cwd: string, home: string): string | null {
  if (NOT_LITERAL.test(text) || text.startsWith('-') || SLASH_OPTION.test(text)) return null;
  return resolved(text, cwd, home) ?? win.resolve(cwd, text);
}

// Git Bash cp is GNU cp, where `-Path` is the flag cluster -P -a -t h, so only PowerShell's Copy-Item gets parameter names.
function copySides(args: string[], powershell: boolean): { source: string; destination: string } | null {
  const positional: string[] = [];
  let source: string | null = null;
  let destination: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const lower = args[i].toLowerCase();
    if (lower === (powershell ? '-force' : '-f')) continue;
    if (powershell && (lower === '-path' || lower === '-literalpath')) {
      if (source !== null || i + 1 >= args.length) return null;
      source = args[++i];
    } else if (powershell && lower === '-destination') {
      if (destination !== null || i + 1 >= args.length) return null;
      destination = args[++i];
    } else if (args[i].startsWith('-') || SLASH_OPTION.test(args[i])) {
      return null;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length + (source === null ? 0 : 1) + (destination === null ? 0 : 1) !== 2) return null;
  source ??= positional.shift() as string;
  destination ??= positional.shift() as string;
  return { source, destination };
}

function fileId(p: string): string | null {
  try {
    const s = fs.statSync(p, { bigint: true });
    return `${s.dev}:${s.ino}`;
  } catch {
    return null;
  }
}

// Files a command only reads or replaces with their own copy. The whole command has to be made of deletes, plain reads
// and plain copies onto a deleted file, with no redirect, assignment, directory change or other tool: any other
// statement can overwrite a candidate in ways that cannot be read from its words, so then there are no candidates.
export function readOnlyPaths(command: string, cwd: string, home: string, targets: string[]): string[] {
  if (!PLAIN_COMMAND.test(command) || ESCAPED_QUOTE_OR_LONE_CR.test(command)) return [];
  const deleted = new Set(targets.map((t) => win.normalize(t).replace(/\\+$/, '').toLowerCase()));
  const found: string[] = [];
  const written: string[] = [];
  for (const statement of splitStatements(command)) {
    const words = [...statement.matchAll(WORD)].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    if (words.length === 0) continue;
    // A command named with a folder (./cat, C:\x\cat.exe) can be any script.
    if (/[\\/:]/.test(words[0])) return [];
    const name = words[0].toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(1);
    if (DELETE_NAMES.has(name)) continue;
    if (READ_NAMES.has(name) && !args.some((a) => a.startsWith('-') || SLASH_OPTION.test(a))) {
      for (const a of args) found.push(operandPath(a, cwd, home) ?? '');
    } else if (name === 'certutil' && (args.length === 2 || args.length === 3) && args[0].toLowerCase() === '-hashfile') {
      found.push(operandPath(args[1], cwd, home) ?? '');
    } else if (name === 'cp' || POWERSHELL_COPY_NAMES.has(name)) {
      const sides = copySides(args, name !== 'cp');
      const destination = sides ? operandPath(sides.destination, cwd, home) : null;
      if (!sides || destination === null || !deleted.has(destination.toLowerCase())) return [];
      found.push(operandPath(sides.source, cwd, home) ?? '');
      written.push(destination);
    } else {
      return [];
    }
  }
  // Copying onto a file rewrites every hard link of it, so a hard link of a copy destination does not keep the old content.
  const overwritten = new Set(written.map(fileId).filter((id) => id !== null));
  const seen = new Set<string>();
  return found.filter((p) => {
    if (p === '' || seen.has(p.toLowerCase())) return false;
    seen.add(p.toLowerCase());
    const id = fileId(p);
    return id !== null && !overwritten.has(id);
  }).slice(0, MAX_NAMED_PATHS);
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
  // Real paths miss hard links. One of the file itself survives its delete; one of another target shares that target's fate.
  const otherTargetIds = new Set(targets.filter((t) => (realKey(t) ?? key(t)) !== own).map(fileId).filter((id) => id !== null));
  for (const copy of named) {
    const real = realKey(copy);
    if (real === null || real === own || blocked.some((t) => within(real, t) || within(key(copy), t))) continue;
    const id = fileId(copy);
    if (id === null || otherTargetIds.has(id)) continue;
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
  const named = readOnlyPaths(command, cwd, home, paths);
  const limited: GitRunner = (args, env) => (outOfTime() ? { status: null, stdout: '', stderr: '' } : git(args, env));
  return paths.map((target) => {
    if (outOfTime()) return NOT_LIFTED;
    const result = isDirectory(target) ? folderRecovery(target, limited) : fileRecovery(target, named, paths, limited);
    return result.lift === null && outOfTime() ? NOT_LIFTED : result;
  });
}
