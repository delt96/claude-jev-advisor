import path from 'node:path';
import { denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

const win = path.win32;
const SHELLS = new Set(['sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const DELETES = new Set(['del', 'erase', 'rd', 'rmdir']);
const PREFIXES = new Set(['if', 'for', 'call', 'start']);
const COMMANDS = new Set([...SHELLS, ...DELETES, ...PREFIXES, 'cd', 'chdir', 'pushd', 'popd']);
const DELETE_WORD = /\b(?:del|erase|rd|rmdir)\b/i;
const UNKNOWN = '\u0000';

type CmdWord = { value: string; dynamic: boolean; shown: string; quoted: boolean; end: number };

// cmd expands %NAME% once, when it reads the line, before it splits it into commands.
function expandVars(line: string, vars: Map<string, string>): string {
  return line
    .replace(/%([^%\s"]+)%/g, (_m, name: string) => vars.get(name.toLowerCase()) ?? UNKNOWN)
    .replace(/%~[^\s"]*/g, UNKNOWN)
    .replace(/![^!\s"]+!/g, UNKNOWN);
}

// A parenthesis is a block only where cmd expects a command: at the start, or after if, for … do or else.
const OPENS_BLOCK = /^\s*@?(?:|(?:if|else)\b.*|for\b.*\bdo)\s*$/i;

function segmentsOf(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  const cut = () => {
    out.push(current);
    current = '';
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '^' && i + 1 < line.length) {
      current += c + line[++i];
      continue;
    }
    if (!quoted && c === '(' && OPENS_BLOCK.test(current)) {
      cut();
      depth++;
      continue;
    }
    if (!quoted && c === ')' && depth > 0) {
      cut();
      depth--;
      continue;
    }
    const redirect = c === '&' && /[<>]$/.test(current);
    if (!quoted && !redirect && '&|\n'.includes(c)) {
      cut();
      if ((c === '&' || c === '|') && line[i + 1] === c) i++;
      continue;
    }
    current += c;
  }
  out.push(current);
  return out.filter((s) => s.trim() !== '');
}

function wordsOf(segment: string, delimiters: string): CmdWord[] {
  const words: CmdWord[] = [];
  let word: CmdWord | null = null;
  let quoted = false;
  let skipNext = false;
  const start = (): CmdWord => (word ??= { value: '', dynamic: false, shown: '', quoted: false, end: 0 });
  const add = (c: string) => {
    const w = start();
    if (c === UNKNOWN) {
      w.dynamic = true;
      w.shown += '%?%';
    } else {
      w.value += c;
      w.shown += c;
    }
  };
  const finish = (at: number) => {
    if (word === null) return;
    word.end = at;
    if (skipNext) skipNext = false;
    else words.push(word);
    word = null;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '"') {
      quoted = !quoted;
      start().quoted = true;
      continue;
    }
    if (quoted) {
      add(c);
      continue;
    }
    if (c === '^') {
      if (i + 1 < segment.length) add(segment[++i]);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || delimiters.includes(c)) {
      finish(i);
      continue;
    }
    if (c === '>' || c === '<') {
      if (word !== null && /^\d$/.test((word as CmdWord).value) && !(word as CmdWord).dynamic) word = null;
      else finish(i);
      while (segment[i + 1] === '>') i++;
      if (segment[i + 1] === '&') {
        i++;
        while (/\d/.test(segment[i + 1] ?? '')) i++;
        continue;
      }
      skipNext = true;
      continue;
    }
    add(c);
  }
  finish(segment.length);
  return words;
}

// cmd reads a built-in's name up to the first `/`, and `cd` up to the first `.` or `\` as well (`del/q`, `cd..`).
function nameOf(word: CmdWord): { name: string; rest: string } | null {
  if (word.dynamic && /%\?%[^\\/]*$/.test(word.shown)) return null;
  const text = word.value.replace(/^@/, '');
  const glued = /^(del|erase|rd|rmdir|cd|chdir|pushd|popd)(\/.*)$/i.exec(text) ?? /^(cd|chdir)([.\\].*)$/i.exec(text);
  if (glued) return { name: glued[1].toLowerCase(), rest: glued[2] };
  return { name: win.basename(text.replace(/\//g, '\\')).replace(/\.(?:exe|com)$/i, '').toLowerCase(), rest: '' };
}

function classify(word: CmdWord, cwd: string | null, everywhere: boolean, ctx: ReadCtx): { real?: RmTarget; unresolvable?: string } {
  if (word.dynamic || word.value.includes('%')) return { unresolvable: `a variable that cannot be worked out (${word.shown})` };
  let base = word.value;
  let pattern: string | null = null;
  if (everywhere || /[*?]/.test(word.value)) {
    const split = splitWindowsPattern(word.value, /[*?]/);
    if (split === null) return { unresolvable: `a wildcard in a folder name (${word.value})` };
    base = split.dir;
    pattern = split.pattern;
  }
  const resolved = resolveWindowsPath(base, cwd, null);
  if ('unresolvable' in resolved) return { unresolvable: resolved.unresolvable };
  if ('unc' in resolved) return { real: { shown: word.value, path: null } };
  return { real: judgePath(resolved.path, pattern, ctx) ?? undefined };
}

export function readCmd(line: string, ctx: ReadCtx): ReadResult {
  const out = emptyRead();
  const vars = new Map<string, string>();
  for (const name of ['TEMP', 'TMP', 'USERPROFILE']) {
    const value = ctx.env[name];
    if (value) vars.set(name.toLowerCase(), value);
  }
  if (ctx.cwd !== null) vars.set('cd', ctx.cwd);
  let cwd = ctx.cwd;
  let deny: string | null = null;
  const refuse = (why: string) => {
    deny ??= denyReason('cmd', why);
  };
  const run = (segment: string, words: CmdWord[], from: number, scan: boolean): void => {
    let at = from;
    if (scan) {
      while (at < words.length && !COMMANDS.has(nameOf(words[at])?.name ?? '')) at++;
      if (at === words.length) return;
    }
    const first = words[at];
    if (!first) return;
    const named = nameOf(first);
    if (named === null) {
      if (DELETE_WORD.test(segment)) refuse(`a command that cannot be worked out (${first.shown})`);
      return;
    }
    const { name, rest } = named;
    const args = () => [...(rest ? wordsOf(rest, ',;=') : []), ...wordsOf(segment.slice(first.end), ',;=')];
    if (/^[a-z]:$/.test(first.value.replace(/^@/, '').toLowerCase())) {
      cwd = null;
    } else if (name === 'if' || name === 'call' || name === 'start') {
      run(segment, words, at + 1, true);
    } else if (name === 'for') {
      const go = words.findIndex((w, i) => i > at && !w.dynamic && w.value.toLowerCase() === 'do');
      if (go !== -1) run(segment, words, go + 1, true);
    } else if (SHELLS.has(name)) {
      out.shells.push({ name, args: words.slice(at + 1).map((w) => (w.dynamic ? null : w.value)), cwd, raw: segment.trim().split(UNKNOWN).join('%?%') });
    } else if (name === 'popd') {
      cwd = null;
    } else if (name === 'cd' || name === 'chdir' || name === 'pushd') {
      const given = args();
      const switchDrive = name === 'pushd' || given.some((w) => !w.dynamic && w.value.toLowerCase() === '/d');
      const parts = given.filter((w) => w.dynamic || w.value.toLowerCase() !== '/d');
      if (!parts.length) return;
      const resolved = parts.some((w) => w.dynamic) ? null : resolveWindowsPath(parts.map((w) => w.value).join(' '), cwd, null);
      if (resolved === null || !('path' in resolved)) cwd = null;
      else if (switchDrive || cwd === null || resolved.path.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase()) cwd = resolved.path;
    } else if (DELETES.has(name)) {
      const given = args();
      // del /s deletes the name in every subfolder, so the name is a pattern, not one file.
      const everywhere = (name === 'del' || name === 'erase') && given.some((w) => !w.dynamic && /^\/s$/i.test(w.value));
      for (const word of given) {
        if (!word.dynamic && word.value.startsWith('/')) continue;
        const c = classify(word, cwd, everywhere, ctx);
        if (c.unresolvable) return refuse(c.unresolvable);
        if (c.real) out.targets.push(c.real);
      }
    }
  };
  for (const segment of segmentsOf(expandVars(line, vars))) {
    run(segment, wordsOf(segment, ''), 0, false);
    if (deny !== null) return { ...out, deny };
  }
  return out;
}
