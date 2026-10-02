import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLines, type Entry } from '../context/transcript.js';
import { stripHeredocs } from './guard.js';

export const SESSION_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const CALLS_PER_TARGET = 3;

export type CallKind = 'create' | 'change' | 'read' | 'shell';
export type ToolCall = { tool: string; file: string | null; text: string; kind: CallKind };
export type SessionLog = { startedAt: number; calls: ToolCall[] };
export type FileEntry = { name: string; bornAt: number };
export type Listing = { entries: FileEntry[]; more: boolean };
export type FactProbe = {
  info(p: string): { folder: boolean; bornAt: number } | null;
  list(dir: string, limit: number): Listing | null;
  tracked(p: string): boolean;
  ignored(p: string): boolean;
};
export type TargetFacts = {
  path: string;
  folder: boolean;
  bornAt: number;
  listing: Listing | null;
  tracked: boolean;
  ignored: boolean;
  existedBefore: boolean;
  createdBy: ToolCall[];
};
export type Candidate = 'session' | 'ignored';

const win = path.win32;
const DELETING = /\b(?:rm|rmdir|del|erase|rd|ri|Remove-Item|xargs)\b/i;
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callOf(tool: string, input: Record<string, unknown>, result: string | undefined): ToolCall | null {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (tool) {
    case 'Write':
      return { tool, file: text('file_path'), text: text('content'), kind: result === 'create' ? 'create' : 'change' };
    case 'Edit':
      return { tool, file: text('file_path'), text: text('new_string'), kind: 'change' };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return { tool, file: text('file_path'), text: edits.map((e) => (isRecord(e) && typeof e.new_string === 'string' ? e.new_string : '')).join('\n'), kind: 'change' };
    }
    case 'NotebookEdit':
      return { tool, file: text('notebook_path'), text: text('new_source'), kind: 'change' };
    case 'Read':
      return { tool, file: text('file_path'), text: '', kind: 'read' };
    case 'Bash':
    case 'PowerShell':
      return { tool, file: null, text: text('command'), kind: 'shell' };
    default:
      return null;
  }
}

function resultTypes(entries: Entry[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'user' || !isRecord(entry.toolUseResult) || typeof entry.toolUseResult.type !== 'string' || !isRecord(entry.message)) continue;
    const content = entry.message.content;
    const block = Array.isArray(content) ? content[0] : undefined;
    if (isRecord(block) && typeof block.tool_use_id === 'string') types.set(block.tool_use_id, entry.toolUseResult.type);
  }
  return types;
}

function toolCalls(entries: Entry[]): ToolCall[] {
  const results = resultTypes(entries);
  const calls: ToolCall[] = [];
  for (const entry of entries) {
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string' || !isRecord(block.input)) continue;
      const call = callOf(block.name, block.input, typeof block.id === 'string' ? results.get(block.id) : undefined);
      if (call) calls.push(call);
    }
  }
  return calls;
}

export function readSessionLog(file: string, maxBytes = SESSION_LOG_MAX_BYTES): SessionLog | null {
  let text: string;
  try {
    if (fs.statSync(file).size > maxBytes) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const entries = parseLines(text);
  const first = entries.find((e) => typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp)));
  return first ? { startedAt: Date.parse(first.timestamp as string), calls: toolCalls(entries) } : null;
}

function normalized(text: string): string {
  return text
    .replace(/\\/g, '/')
    .replace(/(^|[\s"'=(>])\/([A-Za-z])\//g, '$1$2:/')
    .toLowerCase();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shellRefs(target: string, cwd: string | null): string[] {
  const refs = [`(?<![\\w.-])${escaped(normalized(target))}(?![\\w.-])`];
  const relative = cwd === null ? '' : win.relative(cwd, target);
  if (relative && !relative.startsWith('..') && !win.isAbsolute(relative)) {
    refs.push(`(?<![\\w.\\-/:])(?:\\./)?${escaped(normalized(relative))}(?![\\w.-])`);
  }
  return refs;
}

export function namesTarget(call: ToolCall, target: string, folder: boolean, cwd: string | null): boolean {
  const wanted = normalized(target);
  if (call.file !== null) {
    const file = normalized(call.file);
    return file === wanted || (folder && file.startsWith(`${wanted}/`));
  }
  // The rm being checked is already in the transcript, and an earlier delete is no sign that Claude made the file.
  if (DELETING.test(call.text)) return false;
  const text = normalized(call.text);
  return shellRefs(target, cwd).some((ref) => new RegExp(ref).test(text));
}

type ShellCommand = { words: string[]; writes: string[] };

function shellCommands(text: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  let current: ShellCommand = { words: [], writes: [] };
  let word: string | null = null;
  let redirect: string | null = null;
  const endWord = () => {
    if (word === null) return;
    if (redirect === null) current.words.push(word);
    else if (redirect === '>' || redirect === '&>') current.writes.push(word);
    word = null;
    redirect = null;
  };
  const endCommand = () => {
    endWord();
    commands.push(current);
    current = { words: [], writes: [] };
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const stop = close === -1 ? text.length : close;
      word = (word ?? '') + text.slice(i + 1, stop);
      i = stop;
    } else if (c === '\\') {
      word = (word ?? '') + (text[i + 1] ?? '');
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')' || (c === '&' && text[i + 1] !== '>')) {
      endCommand();
    } else if (c === '>' || c === '<' || c === '&') {
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      let op = c;
      while (text[i + 1] === '>' || text[i + 1] === '&' || text[i + 1] === '|') op += text[++i];
      redirect = op;
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand();
  return commands;
}

const pathWord = (word: string) =>
  word
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z])\//, '$1:/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();

export function createsTarget(call: ToolCall, target: string, cwd: string | null): boolean {
  if (call.kind !== 'shell') return call.kind === 'create';
  const full = pathWord(target);
  const relative = cwd === null ? '' : win.relative(cwd, target);
  const short = relative && !relative.startsWith('..') && !win.isAbsolute(relative) ? pathWord(relative) : null;
  let moved = false;
  // Only steps that visibly make the target count; after a cd, a relative name may mean another file.
  const isTarget = (word: string | undefined) => word !== undefined && (pathWord(word) === full || (!moved && pathWord(word) === short));
  for (const { words, writes } of shellCommands(stripHeredocs(call.text))) {
    if (writes.some(isTarget)) return true;
    const start = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const args = start === -1 ? [] : words.slice(start);
    const name = win.basename((args[0] ?? '').replace(/\//g, '\\')).replace(/\.exe$/i, '').toLowerCase();
    if ((name === 'touch' || name === 'mkdir') && args.slice(1).some(isTarget)) return true;
    if (name === 'curl' && args.some((w, i) => (w === '-o' || w === '--output') && isTarget(args[i + 1]))) return true;
    if (name === 'cd' || name === 'pushd' || name === 'popd') moved = true;
  }
  return false;
}

export function gatherFacts(target: string, cwd: string | null, session: SessionLog, probe: FactProbe, maxFiles: number): TargetFacts | null {
  const info = probe.info(target);
  if (!info) return null;
  const naming = session.calls.filter((call) => namesTarget(call, target, info.folder, cwd));
  return {
    path: target,
    folder: info.folder,
    bornAt: info.bornAt,
    listing: info.folder ? probe.list(target, maxFiles) : null,
    tracked: probe.tracked(target),
    ignored: info.folder && probe.ignored(target),
    // Write, Edit and sed -i replace a file, which resets its Windows birth time, so the birth time alone cannot tell
    // a new file from an edited one: the first call that named the target must be the one that visibly created it.
    existedBefore: naming.length === 0 || !createsTarget(naming[0], target, cwd),
    createdBy: naming.length <= CALLS_PER_TARGET ? naming : [naming[0], ...naming.slice(1 - CALLS_PER_TARGET)],
  };
}

export function candidateKind(facts: TargetFacts, startedAt: number): Candidate | null {
  const fresh = (bornAt: number) => bornAt >= startedAt;
  const freshInside = !facts.folder || (facts.listing !== null && !facts.listing.more && facts.listing.entries.every((e) => fresh(e.bornAt)));
  if (!facts.tracked && !facts.existedBefore && facts.createdBy.length > 0 && fresh(facts.bornAt) && freshInside) return 'session';
  if (facts.folder && facts.ignored) return 'ignored';
  return null;
}

const bornAt = (stat: fs.Stats) => (stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);

function git(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, LC_ALL: 'C', ...extraEnv };
  for (const name of GIT_LOCATION_ENV) delete env[name];
  return spawnSync('git', args, { encoding: 'utf8', timeout: 3000, windowsHide: true, env });
}

export const realFactProbe: FactProbe = {
  info(p) {
    try {
      const stat = fs.lstatSync(p);
      return { folder: stat.isDirectory(), bornAt: bornAt(stat) };
    } catch {
      return null;
    }
  },
  list(dir, limit) {
    const entries: FileEntry[] = [];
    let more = false;
    const walk = (folder: string, prefix: string): void => {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        if (more) return;
        const full = path.join(folder, item.name);
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(full, name);
        } else if (entries.length >= limit) {
          more = true;
        } else {
          entries.push({ name, bornAt: bornAt(fs.lstatSync(full)) });
        }
      }
    };
    try {
      walk(dir, '');
      return { entries, more };
    } catch {
      return null;
    }
  },
  tracked(p) {
    // Windows paths are case-insensitive but git pathspecs are not; check-ignore refuses this setting, ls-files needs it.
    const r = git(['-C', win.dirname(p), 'ls-files', '--', p], { GIT_ICASE_PATHSPECS: '1' });
    if (r.status === 0) return r.stdout.trim() !== '';
    // Only "not a git repository" is a clear no; git missing, a timeout or any other failure leaves it unknown, and unknown counts as tracked.
    return !(r.status === 128 && /not a git repository/i.test(r.stderr ?? ''));
  },
  ignored(p) {
    return git(['-C', win.dirname(p), 'check-ignore', '-q', '--', p]).status === 0;
  },
};
