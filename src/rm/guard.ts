import path from 'node:path';
import { DELETE_WORDS, decisionOf, denyReason, emptyRead, judgePath, splitWindowsPattern, type Probe, type ReadCtx, type ReadResult, type RmDecision, type RmTarget } from './targets.js';

export { hookOutput, realProbe, type Probe, type RmDecision, type RmTarget } from './targets.js';

const win = path.win32;
const SEPARATORS = new Set([';', '&&', '||', '|', '|&', '&', '(', ')']);
const SKIP_WORDS = new Set(['then', 'else', 'elif', 'do', 'while', 'until', 'if', '!', '{', 'time']);
const HEADER_WORDS = new Set(['for', 'select', 'case']);
const CLOSING_WORDS = new Set(['done', 'fi', 'esac', '}']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const DECLARERS = new Set(['export', 'readonly', 'declare', 'typeset', 'local']);
const KNOWN_ENV = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'];
const SHELLS = new Set(['sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const SHELL_WORDS = /\b(?:sh|bash|cmd|powershell|pwsh)(?:\.exe)?\b/i;

type Word = { value: string; dynamic: boolean; glob: boolean; tilde: boolean; brace: boolean };
type WordToken = Word & { type: 'word' };
type Token = WordToken | { type: 'op'; value: string };
type Command = { words: WordToken[]; after: string | null };
type Vars = Map<string, string | null>;
type BashPath = { path?: string; unknown?: string; unresolvable?: string };
type Classified = { real?: RmTarget; unresolvable?: string };

export type DecideInput = {
  command: string;
  cwd: string | null;
  home: string;
  tmpdirs: string[];
  env?: Record<string, string | undefined>;
  probe: Probe;
};
type Ctx = { cwd: string | null; home: string; tmpdirs: string[]; probe: Probe; vars: Vars };

export function stripHeredocs(text: string): string {
  const out: string[] = [];
  const pending: { dash: boolean; word: string }[] = [];
  for (const line of text.split('\n')) {
    if (pending.length) {
      const { dash, word } = pending[0];
      if ((dash ? line.replace(/^\t+/, '') : line).trimEnd() === word) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g)) pending.push({ dash: m[1] === '-', word: m[3] });
  }
  return out.join('\n');
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let word = null as Word | null;
  let skipNextWord = false;
  const start = (): Word => (word ??= { value: '', dynamic: false, glob: false, tilde: false, brace: false });
  const finish = () => {
    if (word === null) return;
    if (skipNextWord) skipNextWord = false;
    else tokens.push({ type: 'word', ...word });
    word = null;
  };
  const readBalanced = (open: string, close: string): string => {
    let depth = 0;
    const from = i;
    for (; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) { i++; return text.slice(from, i); }
    }
    return text.slice(from);
  };
  const readDollar = () => {
    const w = start();
    w.dynamic = true;
    if (text[i + 1] === '(') { w.value += '$'; i++; w.value += readBalanced('(', ')'); return; }
    if (text[i + 1] === '{') { w.value += '$'; i++; w.value += readBalanced('{', '}'); return; }
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i));
    if (m) { w.value += m[0]; i += m[0].length; return; }
    w.dynamic = false;
    w.value += '$';
    i++;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { finish(); i++; continue; }
    if (c === '\n') { finish(); tokens.push({ type: 'op', value: ';' }); i++; continue; }
    if (c === '#' && word === null) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      start().value += text.slice(i + 1, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') {
      const w = start();
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) { w.value += text[i + 1]; i += 2; continue; }
        if (text[i] === '$') { readDollar(); continue; }
        if (text[i] === '`') { w.dynamic = true; const end = text.indexOf('`', i + 1); w.value += text.slice(i, end === -1 ? text.length : end + 1); i = end === -1 ? text.length : end + 1; continue; }
        w.value += text[i++];
      }
      i++;
      continue;
    }
    if (c === '\\') { start().value += text[i + 1] ?? ''; i += 2; continue; }
    if (c === '$') { readDollar(); continue; }
    if (c === '`') {
      const w = start();
      w.dynamic = true;
      const end = text.indexOf('`', i + 1);
      w.value += text.slice(i, end === -1 ? text.length : end + 1);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && text[i + 1] === '>')) {
      if (word !== null && /^\d+$/.test(word.value) && !word.dynamic) word = null;
      else finish();
      const m = /^(&>>?|\d*[<>]+[&|]?)/.exec(text.slice(i))!;
      i += m[0].length;
      if (/&$/.test(m[0]) && /^\d|^-/.test(text[i] ?? '')) { while (i < text.length && /[\d-]/.test(text[i])) i++; continue; }
      skipNextWord = true;
      continue;
    }
    const op = ['&&', '||', '|&', ';;', ';', '|', '&', '(', ')'].find((o) => text.startsWith(o, i));
    if (op) { finish(); tokens.push({ type: 'op', value: op === ';;' ? ';' : op }); i += op.length; continue; }
    const w = start();
    if (c === '~' && w.value === '') w.tilde = true;
    if ('*?['.includes(c)) w.glob = true;
    if (c === '{' && /^\{[^}]*,[^}]*\}/.test(text.slice(i))) w.brace = true;
    w.value += c;
    i++;
  }
  finish();
  return tokens;
}

function splitCommands(tokens: Token[]): Command[] {
  const commands: Command[] = [];
  let current: WordToken[] = [];
  for (const t of tokens) {
    if (t.type === 'op' && SEPARATORS.has(t.value)) {
      commands.push({ words: current, after: t.value });
      current = [];
    } else if (t.type === 'word') current.push(t);
  }
  commands.push({ words: current, after: null });
  return commands;
}

function expand(word: { value: string; dynamic: boolean }, vars: Vars): string | null {
  if (!word.dynamic) return word.value;
  let known = true;
  const out = word.value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m: string, braced?: string, bare?: string) => {
    const v = vars.get(braced ?? bare ?? '');
    if (typeof v !== 'string') { known = false; return m; }
    return v;
  });
  return known && !/[$`]/.test(out) ? out : null;
}

function assign(word: Word, vars: Vars, home: string): void {
  const name = ASSIGNMENT.exec(word.value)![1];
  let value = expand({ value: word.value.slice(name.length + 1), dynamic: word.dynamic }, vars);
  if (value !== null && /^~(?:[\\/]|$)/.test(value)) value = home + value.slice(1);
  vars.set(name, value);
}

function commandName(word: Word): string | null {
  if (word.dynamic) return null;
  return win.basename(word.value.replace(/\//g, '\\')).replace(/\.exe$/i, '').toLowerCase();
}

function stripPrefixes(words: WordToken[]): WordToken[] {
  let rest = words;
  for (;;) {
    while (rest.length && ASSIGNMENT.test(rest[0].value)) rest = rest.slice(1);
    if (!rest.length) return rest;
    const name = commandName(rest[0]);
    if (SKIP_WORDS.has(rest[0].value) || name === 'command' || name === 'builtin' || name === 'exec' || name === 'nohup') { rest = rest.slice(1); continue; }
    if (name === 'sudo' || name === 'env') {
      rest = rest.slice(1);
      while (rest.length && !rest[0].dynamic && rest[0].value.startsWith('-')) rest = rest.slice(1);
      continue;
    }
    if (name === 'timeout') {
      rest = rest.slice(1);
      while (rest.length && !rest[0].dynamic && rest[0].value.startsWith('-')) rest = rest.slice(1);
      rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

function toWindowsPath(word: Word, cwd: string | null, home: string, tmpdir: string): BashPath {
  const v = word.value;
  if (word.tilde && (v === '~' || v.startsWith('~/') || v.startsWith('~\\'))) return { path: win.resolve(home, v.slice(2) || '.') };
  if (/^[A-Za-z]:[\\/]/.test(v)) return { path: win.normalize(v) };
  const drive = /^\/([A-Za-z])(?:\/(.*))?$/.exec(v);
  if (drive) return { path: win.normalize(`${drive[1].toUpperCase()}:\\${drive[2] ?? ''}`) };
  const tmp = /^\/tmp(?:\/(.*))?$/.exec(v);
  if (tmp) return { path: win.resolve(tmpdir, tmp[1] ?? '.') };
  if (v.startsWith('/')) return { unknown: v };
  if (cwd === null) return { unresolvable: 'a relative path after cd to a path that cannot be worked out' };
  return { path: win.resolve(cwd, v) };
}

function classify(target: WordToken, ctx: Ctx): Classified {
  if (target.brace) return { unresolvable: `brace expansion (${target.value})` };
  const value = expand(target, ctx.vars);
  if (value === null) return { unresolvable: `a shell variable or command substitution that cannot be worked out (${target.value})` };
  let w: Word = { ...target, value, dynamic: false };
  let pattern: string | null = null;
  if (target.glob) {
    const split = splitWindowsPattern(value, /[*?[]/);
    if (split === null) return { unresolvable: `a wildcard in a folder name (${target.value})` };
    pattern = split.pattern;
    w = { ...w, value: split.dir };
  }
  const resolved = toWindowsPath(w, ctx.cwd, ctx.home, ctx.tmpdirs[0]);
  if (resolved.unresolvable) return { unresolvable: resolved.unresolvable };
  if (resolved.unknown) return { real: { shown: target.value, path: null } };
  return { real: judgePath(resolved.path!, pattern, ctx) ?? undefined };
}

export function readBash(command: string, { cwd, home, tmpdirs, env, probe }: ReadCtx): ReadResult {
  const out = emptyRead();
  if (!/\b(?:rm|rmdir|xargs)\b/.test(command) && !SHELL_WORDS.test(command)) return out;
  const commands = splitCommands(tokenize(stripHeredocs(command)));
  const vars: Vars = new Map(KNOWN_ENV.filter((n) => env[n]).map((n): [string, string] => [n, env[n] as string]));
  const ctx: Ctx = { cwd, home, tmpdirs, probe, vars };
  const setCwd = (next: string | null) => { ctx.cwd = next; vars.set('PWD', next); };
  const deny = (why: string): ReadResult => ({ ...out, deny: denyReason('bash', why) });
  setCwd(cwd);
  const stack: (string | null)[] = [];
  let piped = false;
  for (const { words, after } of commands) {
    const rest = stripPrefixes(words);
    if (!rest.length) {
      for (const w of words) if (ASSIGNMENT.test(w.value)) assign(w, vars, home);
    } else if (HEADER_WORDS.has(rest[0].value)) {
      if (rest[0].value !== 'case' && rest[1]) vars.set(rest[1].value, null);
    } else if (!CLOSING_WORDS.has(rest[0].value)) {
      const name = commandName(rest[0]);
      if (name !== null && DECLARERS.has(name)) {
        for (const w of rest.slice(1)) if (ASSIGNMENT.test(w.value)) assign(w, vars, home);
      } else if (name === 'cd' || name === 'pushd' || name === 'popd') {
        const arg = rest[1];
        const value = arg ? expand(arg, vars) : null;
        if (name === 'popd' || (arg && (value === null || value === '-'))) setCwd(null);
        else if (!arg) setCwd(home);
        else setCwd(toWindowsPath({ ...arg, value: value as string }, ctx.cwd, home, tmpdirs[0]).path ?? null);
      } else if (name === 'xargs') {
        if (rest.slice(1).some((t) => { const n = commandName(t); return n === 'rm' || n === 'rmdir'; })) return deny('xargs feeding rm');
        if (rest.slice(1).some((t) => SHELLS.has(commandName(t) ?? '')) && DELETE_WORDS.test(rest.slice(1).map((t) => t.value).join(' '))) return deny('xargs feeding a shell that deletes');
      } else if (name !== null && SHELLS.has(name)) {
        out.shells.push({ name, args: rest.slice(1).map((t) => (t.brace ? null : expand(t, vars))), cwd: ctx.cwd, raw: rest.map((t) => t.value).join(' '), ...(piped ? { piped } : {}) });
      } else if (name === 'rm' || name === 'rmdir') {
        let options = true;
        for (const t of rest.slice(1)) {
          if (options && !t.dynamic && t.value === '--') { options = false; continue; }
          if (options && !t.dynamic && t.value.length > 1 && t.value.startsWith('-')) continue;
          const c = classify(t, ctx);
          if (c.unresolvable) return deny(c.unresolvable);
          if (c.real) out.targets.push(c.real);
        }
      }
    }
    piped = after === '|' || after === '|&';
    if (after === '(') stack.push(ctx.cwd);
    if (after === ')' && stack.length) setCwd(stack.pop() ?? null);
  }
  return out;
}

export function decide({ command, env = {}, ...rest }: DecideInput): RmDecision | null {
  return decisionOf(readBash(command, { ...rest, env }));
}
