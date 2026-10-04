import path from 'node:path';
import { denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

const win = path.win32;
const SHELLS = new Set(['sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const DELETES = new Set(['del', 'erase', 'rd', 'rmdir']);
const CONTROL = new Set(['if', 'else', 'for', 'call', 'start']);
const DELETE_WORD = /(?<![\w.-])(?:del|erase|rd|rmdir|rm|ri|remove-item)(?![\w-])|::\s*delete\b/i;
const UNKNOWN = '\u0000';
const EXCERPT_CHARS = 200;

type CmdWord = { value: string; dynamic: boolean; shown: string; end: number };

// cmd expands %NAME% once, when it reads the line, before it splits it into commands.
function expandVars(line: string, vars: Map<string, string>): string {
  return line
    .replace(/%([^%\s"]+)%/g, (_m, name: string) => vars.get(name.toLowerCase()) ?? UNKNOWN)
    .replace(/%~[^\s"]*/g, UNKNOWN)
    .replace(/![^!\s"]+!/g, UNKNOWN);
}

function hasBlock(line: string): boolean {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (!quoted && line[i] === '^') i++;
    else if (!quoted && (line[i] === '(' || line[i] === ')')) return true;
  }
  return false;
}

function segmentsOf(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    if (!quoted && c === '^' && i + 1 < line.length) {
      current += c + line[++i];
      continue;
    }
    const redirect = c === '&' && /[<>]$/.test(current);
    if (!quoted && !redirect && '&|\n'.includes(c)) {
      out.push(current);
      current = '';
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
  const start = (): CmdWord => (word ??= { value: '', dynamic: false, shown: '', end: 0 });
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
      start();
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

// cmd reads a built-in's name up to the first `/`, `,`, `;` or `=`, and `cd`'s up to a `.` or `\` too (`del/q`, `cd..`).
function nameOf(word: CmdWord): { name: string; rest: string } | null {
  if (word.dynamic && /%\?%[^\\/]*$/.test(word.shown)) return null;
  const text = word.value.replace(/^@/, '');
  const glued = /^(del|erase|rd|rmdir|cd|chdir|pushd|popd)([/,;=].*)$/i.exec(text) ?? /^(cd|chdir)([.\\].*)$/i.exec(text);
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
  const deny = (why: string): ReadResult => ({ ...out, deny: denyReason('cmd', why) });
  const expanded = expandVars(line, vars);
  // cmd skips spaces, @, commas, semicolons and equals signs before a command name.
  const segments = segmentsOf(expanded).map((s) => s.replace(/^[\s@,;=]+/, '')).filter((s) => s !== '');
  // if, else, for, call, start and parenthesized blocks run commands where this reader does not follow, and a partial
  // reading of them let real deletes through, so a line that uses them anywhere is refused as a whole when it deletes.
  const control = segments.some((s) => {
    const first = wordsOf(s, '')[0];
    const named = first ? nameOf(first) : null;
    return first !== undefined && (named === null || CONTROL.has(named.name));
  });
  if (control || hasBlock(expanded)) {
    if (!DELETE_WORD.test(expanded)) return out;
    const shown = expanded.trim().replace(/\s+/g, ' ').slice(0, EXCERPT_CHARS).split(UNKNOWN).join('%?%');
    return deny(`a delete on a cmd line with if, else, for, call, start, parentheses or a command that cannot be worked out (${shown}); write plain del or rd lines, with names that hold parentheses in double quotes`);
  }
  for (const segment of segments) {
    const words = wordsOf(segment, '');
    if (!words.length) continue;
    const first = words[0];
    const named = nameOf(first) as { name: string; rest: string };
    const shown = segment.trim().split(UNKNOWN).join('%?%');
    const { name, rest } = named;
    const args = () => [...(rest ? wordsOf(rest, ',;=') : []), ...wordsOf(segment.slice(first.end), ',;=')];
    if (/^[a-z]:$/i.test(first.value.replace(/^@/, ''))) {
      cwd = null;
    } else if (SHELLS.has(name)) {
      out.shells.push({ name, args: words.slice(1).map((w) => (w.dynamic ? null : w.value)), cwd, raw: shown });
    } else if (name === 'popd') {
      cwd = null;
    } else if (name === 'cd' || name === 'chdir' || name === 'pushd') {
      const given = args();
      const switchDrive = name === 'pushd' || given.some((w) => !w.dynamic && w.value.toLowerCase() === '/d');
      const parts = given.filter((w) => w.dynamic || w.value.toLowerCase() !== '/d');
      if (!parts.length) continue;
      const resolved = parts.some((w) => w.dynamic) ? null : resolveWindowsPath(parts.map((w) => w.value).join(' '), cwd, null);
      if (resolved === null || !('path' in resolved)) cwd = null;
      else if (switchDrive || cwd === null || resolved.path.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase()) cwd = resolved.path;
    } else if (DELETES.has(name)) {
      const given = args();
      const switches = given.filter((w) => !w.dynamic && w.value.startsWith('/'));
      // del /s deletes the name in every subfolder, so the name is a pattern, not one file.
      const everywhere = (name === 'del' || name === 'erase') && switches.some((w) => w.value.split('/').some((s) => s.toLowerCase() === 's'));
      for (const word of given) {
        if (switches.includes(word)) continue;
        const c = classify(word, cwd, everywhere, ctx);
        if (c.unresolvable) return deny(c.unresolvable);
        if (c.real) out.targets.push(c.real);
      }
    }
  }
  return out;
}
