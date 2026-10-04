import path from 'node:path';
import { denyReason, emptyRead, judgePath, resolveWindowsPath, splitWindowsPattern, type ReadCtx, type ReadResult, type RmTarget } from './targets.js';

const win = path.win32;
const SHELLS = new Set(['sh', 'bash', 'cmd', 'powershell', 'pwsh']);
const DELETES = new Set(['del', 'erase', 'rd', 'rmdir']);
const UNKNOWN = '\u0000';

type CmdWord = { value: string; dynamic: boolean; shown: string };

// cmd expands %NAME% once, when it reads the line, before it splits it into commands.
function expandVars(line: string, vars: Map<string, string>): string {
  return line
    .replace(/%([^%\s"]+)%/g, (_m, name: string) => vars.get(name.toLowerCase()) ?? UNKNOWN)
    .replace(/%~[^\s"]*/g, UNKNOWN)
    .replace(/![^!\s"]+!/g, UNKNOWN);
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
    if (!quoted && !redirect && '&|()\n'.includes(c)) {
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
  const start = (): CmdWord => (word ??= { value: '', dynamic: false, shown: '' });
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
  const finish = () => {
    if (word === null) return;
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
      finish();
      continue;
    }
    if (c === '>' || c === '<') {
      if (word !== null && /^\d$/.test((word as CmdWord).value) && !(word as CmdWord).dynamic) word = null;
      else finish();
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
  finish();
  return words;
}

function classify(word: CmdWord, cwd: string | null, ctx: ReadCtx): { real?: RmTarget; unresolvable?: string } {
  if (word.dynamic) return { unresolvable: `a variable that cannot be worked out (${word.shown})` };
  let base = word.value;
  let pattern: string | null = null;
  if (/[*?]/.test(word.value)) {
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
  for (const segment of segmentsOf(expandVars(line, vars))) {
    const plain = wordsOf(segment, '');
    if (!plain.length || plain[0].dynamic) continue;
    const first = plain[0].value.replace(/^@/, '');
    const name = win.basename(first.replace(/\//g, '\\')).replace(/\.(?:exe|com)$/i, '').toLowerCase();
    if (/^[A-Za-z]:$/.test(first)) {
      cwd = null;
    } else if (SHELLS.has(name)) {
      out.shells.push({ name, args: plain.slice(1).map((w) => (w.dynamic ? null : w.value)), cwd, raw: segment.trim().split(UNKNOWN).join('%?%') });
    } else if (name === 'popd') {
      cwd = null;
    } else if (name === 'cd' || name === 'chdir' || name === 'pushd') {
      const args = wordsOf(segment, ',;=').slice(1);
      const switchDrive = name === 'pushd' || args.some((w) => !w.dynamic && w.value.toLowerCase() === '/d');
      const parts = args.filter((w) => w.dynamic || w.value.toLowerCase() !== '/d');
      if (!parts.length) continue;
      const resolved = parts.some((w) => w.dynamic) ? null : resolveWindowsPath(parts.map((w) => w.value).join(' '), cwd, null);
      if (resolved === null || !('path' in resolved)) cwd = null;
      else if (switchDrive || cwd === null || resolved.path.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase()) cwd = resolved.path;
    } else if (DELETES.has(name)) {
      for (const word of wordsOf(segment, ',;=').slice(1)) {
        if (!word.dynamic && word.value.startsWith('/')) continue;
        const c = classify(word, cwd, ctx);
        if (c.unresolvable) return { ...out, deny: denyReason('cmd', c.unresolvable) };
        if (c.real) out.targets.push(c.real);
      }
    }
  }
  return out;
}
