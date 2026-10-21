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
const KNOWN_ENV = ['TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA'];
const SHELLS = new Set(['sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const NATIVE_SHELLS = new Set(['cmd', 'powershell', 'pwsh']);
const SHELL_WORDS = /\b(?:sh|bash|cmd|powershell|pwsh)(?:\.exe)?\b/i;
// Marks an expansion inside double quotes, which bash neither splits into more words nor expands as a wildcard.
const QUOTED = '\u0002';
const plain = (value: string) => value.split(QUOTED).join('');
const NAME_SETTERS = new Set(['declare', 'typeset', 'local', 'export', 'readonly', 'let', 'unset']);
const NAME_READERS = new Set(['read', 'mapfile', 'readarray']);
// Options of read and mapfile that take a value rather than a variable name.
const VALUE_OPTIONS = /^-[pdntuNCOs]$/;

// literal: a $ that bash keeps as text (quoted, escaped or alone), which expand must not read as a variable.
type Word = { value: string; dynamic: boolean; glob: boolean; tilde: boolean; brace: boolean; literal: boolean };
type Expandable = Pick<Word, 'value' | 'dynamic'> & Partial<Pick<Word, 'literal'>>;
type WordToken = Word & { type: 'word' };
type Token = WordToken | { type: 'op'; value: string } | { type: 'here' };
type Command = { words: WordToken[]; after: string | null; here: boolean };
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
type Ctx = { cwd: string | null; home: string; tmpdirs: string[]; probe: Probe; vars: Vars; ifs: boolean };

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
  const start = (): Word => (word ??= { value: '', dynamic: false, glob: false, tilde: false, brace: false, literal: false });
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
  const readDollar = (quoted: boolean) => {
    const w = start();
    const was = w.dynamic;
    const mark = quoted ? QUOTED : '';
    w.dynamic = true;
    if (text[i + 1] === '(') { w.value += `${mark}$`; i++; w.value += readBalanced('(', ')'); return; }
    if (text[i + 1] === '{') { w.value += `${mark}$`; i++; w.value += readBalanced('{', '}'); return; }
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i));
    if (m) { w.value += mark + m[0]; i += m[0].length; return; }
    // $'...' and $"..." are quoting forms whose text this reader does not decode, so the word stays unreadable.
    if (!quoted && (text[i + 1] === "'" || text[i + 1] === '"')) { w.literal = true; w.value += '$'; i++; return; }
    w.dynamic = was;
    w.literal = true;
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
      const quoted = text.slice(i + 1, end === -1 ? text.length : end);
      const w = start();
      w.value += quoted;
      if (quoted.includes('$')) w.literal = true;
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"') {
      const w = start();
      i++;
      while (i < text.length && text[i] !== '"') {
        const continued = /^\\\r?\n/.exec(text.slice(i, i + 3));
        if (continued) { i += continued[0].length; continue; }
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1] ?? '')) { if (text[i + 1] === '$') w.literal = true; w.value += text[i + 1]; i += 2; continue; }
        if (text[i] === '$') { readDollar(true); continue; }
        if (text[i] === '`') { w.dynamic = true; const end = text.indexOf('`', i + 1); w.value += text.slice(i, end === -1 ? text.length : end + 1); i = end === -1 ? text.length : end + 1; continue; }
        w.value += text[i++];
      }
      i++;
      continue;
    }
    if (c === '\\') {
      const continued = /^\\\r?\n/.exec(text.slice(i, i + 3));
      if (continued) { i += continued[0].length; continue; }
      const w = start();
      if (text[i + 1] === '$') w.literal = true;
      w.value += text[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === '$') { readDollar(false); continue; }
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
      if (/^\d*<<<?$/.test(m[0])) tokens.push({ type: 'here' });
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
  let here = false;
  for (const t of tokens) {
    if (t.type === 'op' && SEPARATORS.has(t.value)) {
      commands.push({ words: current, after: t.value, here });
      current = [];
      here = false;
    } else if (t.type === 'word') current.push(t);
    else if (t.type === 'here') here = true;
  }
  commands.push({ words: current, after: null, here });
  return commands;
}

// ifs null: an assignment, which bash neither splits nor expands as a wildcard; true: the command may change IFS, so an
// expansion outside double quotes may split anywhere.
function expand(word: Expandable, vars: Vars, ifs: boolean | null): string | null {
  if (!word.dynamic) return word.value;
  if (word.literal) return null;
  let known = true;
  const pattern = /(\u0002?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}|(\u0002?)\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const out = word.value.replace(pattern, (m: string, q1: string, braced: string | undefined, q2: string | undefined, bare: string | undefined) => {
    const v = vars.get(braced ?? bare ?? '');
    const unquoted = ifs !== null && !(q1 || q2);
    if (typeof v !== 'string' || (unquoted && (ifs || /[\s*?[]/.test(v)))) { known = false; return m; }
    return v;
  });
  return known && !/[$`\u0002]/.test(out) ? out : null;
}

function assign(word: Word, vars: Vars, home: string): void {
  const name = ASSIGNMENT.exec(word.value)![1];
  let value = expand({ value: word.value.slice(name.length + 1), dynamic: word.dynamic, literal: word.literal }, vars, null);
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

// Git Bash rewrites an argument that looks like a POSIX path before it starts a Windows program such as cmd or
// powershell: /c/x becomes C:/x, /s becomes S:/, /tmp/x the temp folder and //c becomes /c, while //host/share and /?
// pass unchanged; any other absolute path points into Git's own folder.
function nativeArg(value: string | null, tmpdir: string): string | null {
  if (value === null || !value.startsWith('/') || value === '/?') return value;
  if (value.startsWith('//')) return /^\/\/[^/]*$/.test(value) ? value.slice(1) : value;
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(value);
  if (drive) return `${drive[1].toUpperCase()}:${drive[2] ?? '/'}`;
  const tmp = /^\/tmp(\/.*)?$/.exec(value);
  if (tmp) return `${tmpdir}${(tmp[1] ?? '').replace(/\//g, '\\')}`;
  return null;
}

const ASSUME_REAL: Probe = { exists: () => true, isIgnored: () => false };

// $$ and the read-only PPID always hold digits and are never empty, so inside double quotes they cannot add a folder
// step, a `..` or a second word. RANDOM and BASHPID lose that once unset, which a command can do by a name it builds.
const DIGITS = /\u0002(?:\$\$|\$\{\$\}|\$\{(PPID)\}|\$(PPID)(?![A-Za-z0-9_]))/g;
// Stands in for the digits: it occurs in no real folder name, so the digits can never make up the temp folder itself.
const NO_FOLDER_CHAR = '\u0001';

function classify(target: WordToken, ctx: Ctx): Classified {
  if (target.brace) return { unresolvable: `brace expansion (${plain(target.value)})` };
  const value = expand(target, ctx.vars, ctx.ifs);
  if (value === null) {
    const digits = target.value.replace(DIGITS, (m: string, braced?: string, bare?: string) => (ctx.vars.has(braced ?? bare ?? '') ? m : NO_FOLDER_CHAR));
    const guess = digits === target.value ? null : expand({ ...target, value: digits }, ctx.vars, ctx.ifs);
    if (guess !== null) {
      const c = locate(target, guess, { ...ctx, probe: ASSUME_REAL });
      if (!c.unresolvable && !c.real) return {};
    }
    return { unresolvable: `a shell variable or command substitution that cannot be worked out (${plain(target.value)})` };
  }
  return locate(target, value, ctx);
}

function locate(target: WordToken, value: string, ctx: Ctx): Classified {
  let w: Word = { ...target, value, dynamic: false };
  let pattern: string | null = null;
  if (target.glob) {
    const split = splitWindowsPattern(value, /[*?[]/);
    if (split === null) return { unresolvable: `a wildcard in a folder name (${plain(target.value)})` };
    pattern = split.pattern;
    w = { ...w, value: split.dir };
  }
  const resolved = toWindowsPath(w, ctx.cwd, ctx.home, ctx.tmpdirs[0]);
  if (resolved.unresolvable) return { unresolvable: resolved.unresolvable };
  if (resolved.unknown) return { real: { shown: plain(target.value), path: null } };
  return { real: judgePath(resolved.path!, pattern, ctx) ?? undefined };
}

// A command that sets a variable by a name built while it runs, or runs code the reader does not see, may set IFS.
function setsBuiltName(commands: Command[]): boolean {
  const built = (w: WordToken) => w.dynamic && /[$`]/.test(w.value.split('=')[0]);
  for (const { words } of commands) {
    const rest = stripPrefixes(words);
    if (!rest.length) continue;
    const name = commandName(rest[0]);
    const args = rest.slice(1);
    if (name === null || name === 'eval' || name === 'source' || name === '.') return true;
    if (NAME_SETTERS.has(name) && args.some(built)) return true;
    if (NAME_READERS.has(name)) {
      for (let k = 0; k < args.length; k++) {
        if (!args[k].dynamic && VALUE_OPTIONS.test(args[k].value)) k++;
        else if (!(!args[k].dynamic && args[k].value.startsWith('-')) && built(args[k])) return true;
      }
    }
    if (name === 'printf') {
      const v = args.findIndex((w) => !w.dynamic && w.value === '-v');
      if (v >= 0 && args[v + 1] && built(args[v + 1])) return true;
    }
  }
  return false;
}

export function readBash(command: string, { cwd, home, tmpdirs, env, probe }: ReadCtx): ReadResult {
  const out = emptyRead();
  if (!/\b(?:rm|rmdir|xargs)\b/.test(command) && !SHELL_WORDS.test(command)) return out;
  const commands = splitCommands(tokenize(stripHeredocs(command)));
  const vars: Vars = new Map(KNOWN_ENV.filter((n) => env[n]).map((n): [string, string] => [n, env[n] as string]));
  const ctx: Ctx = { cwd, home, tmpdirs, probe, vars, ifs: /\bIFS\b/.test(command.replace(/['"\\]/g, '')) || setsBuiltName(commands) };
  const setCwd = (next: string | null) => { ctx.cwd = next; vars.set('PWD', next); };
  const deny = (why: string): ReadResult => ({ ...out, deny: denyReason('bash', why) });
  setCwd(cwd);
  const stack: (string | null)[] = [];
  let piped = false;
  for (const { words, after, here } of commands) {
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
        const value = arg ? expand(arg, vars, ctx.ifs) : null;
        if (name === 'popd' || (arg && (value === null || value === '-'))) setCwd(null);
        else if (!arg) setCwd(home);
        else setCwd(toWindowsPath({ ...arg, value: value as string }, ctx.cwd, home, tmpdirs[0]).path ?? null);
      } else if (name === 'xargs') {
        if (rest.slice(1).some((t) => { const n = commandName(t); return n === 'rm' || n === 'rmdir'; })) return deny('xargs feeding rm');
        if (rest.slice(1).some((t) => SHELLS.has(commandName(t) ?? '')) && DELETE_WORDS.test(rest.slice(1).map((t) => plain(t.value)).join(' '))) return deny('xargs feeding a shell that deletes');
      } else if (name !== null && SHELLS.has(name)) {
        const args = rest.slice(1).map((t) => (t.brace ? null : expand(t, vars, ctx.ifs)));
        out.shells.push({ name, args: NATIVE_SHELLS.has(name) ? args.map((a) => nativeArg(a, tmpdirs[0])) : args, cwd: ctx.cwd, raw: rest.map((t) => plain(t.value)).join(' '), ...(piped || here ? { piped: true } : {}) });
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
    piped = after === '|' || after === '|&' || (piped && !words.length && after === '(');
    if (after === '(') stack.push(ctx.cwd);
    if (after === ')' && stack.length) setCwd(stack.pop() ?? null);
  }
  return out;
}

export function decide({ command, env = {}, ...rest }: DecideInput): RmDecision | null {
  return decisionOf(readBash(command, { ...rest, env }));
}
