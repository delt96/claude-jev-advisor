import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseLines, type Entry } from '../context/transcript.js';

export const SESSION_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const CALLS_PER_TARGET = 3;

export type ToolCall = { tool: string; file: string | null; text: string };
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
  createdBy: ToolCall[];
};
export type Candidate = 'session' | 'ignored';

const win = path.win32;
const DELETING = /(^|[\s;&|(])(rm|rmdir|del|rd|Remove-Item)(?=\s|$)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function callOf(tool: string, input: Record<string, unknown>): ToolCall | null {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (tool) {
    case 'Write':
      return { tool, file: text('file_path'), text: text('content') };
    case 'Edit':
      return { tool, file: text('file_path'), text: text('new_string') };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      return { tool, file: text('file_path'), text: edits.map((e) => (isRecord(e) && typeof e.new_string === 'string' ? e.new_string : '')).join('\n') };
    }
    case 'NotebookEdit':
      return { tool, file: text('notebook_path'), text: text('new_source') };
    case 'Bash':
    case 'PowerShell':
      return { tool, file: null, text: text('command') };
    default:
      return null;
  }
}

function toolCalls(entries: Entry[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const entry of entries) {
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.name !== 'string' || !isRecord(block.input)) continue;
      const call = callOf(block.name, block.input);
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
    .replace(/(^|[\s"'=(])\/([A-Za-z])\//g, '$1$2:/')
    .toLowerCase();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function namesTarget(call: ToolCall, target: string, folder: boolean, cwd: string | null): boolean {
  const wanted = normalized(target);
  if (call.file !== null) {
    const file = normalized(call.file);
    return file === wanted || (folder && file.startsWith(`${wanted}/`));
  }
  // The rm being checked is already in the transcript, and an earlier delete is no sign that Claude made the file.
  if (DELETING.test(call.text)) return false;
  const text = normalized(call.text);
  if (new RegExp(`(?<![\\w.-])${escaped(wanted)}(?![\\w.-])`).test(text)) return true;
  if (cwd === null) return false;
  const relative = win.relative(cwd, target);
  if (!relative || relative.startsWith('..') || win.isAbsolute(relative)) return false;
  return new RegExp(`(?<![\\w.\\-/:])(?:\\./)?${escaped(normalized(relative))}(?![\\w.-])`).test(text);
}

export function gatherFacts(target: string, cwd: string | null, session: SessionLog, probe: FactProbe, maxFiles: number): TargetFacts | null {
  const info = probe.info(target);
  if (!info) return null;
  return {
    path: target,
    folder: info.folder,
    bornAt: info.bornAt,
    listing: info.folder ? probe.list(target, maxFiles) : null,
    tracked: probe.tracked(target),
    ignored: info.folder && probe.ignored(target),
    createdBy: session.calls.filter((call) => namesTarget(call, target, info.folder, cwd)).slice(-CALLS_PER_TARGET),
  };
}

export function candidateKind(facts: TargetFacts, startedAt: number): Candidate | null {
  const fresh = (bornAt: number) => bornAt >= startedAt;
  const freshInside = !facts.folder || (facts.listing !== null && !facts.listing.more && facts.listing.entries.every((e) => fresh(e.bornAt)));
  if (!facts.tracked && facts.createdBy.length > 0 && fresh(facts.bornAt) && freshInside) return 'session';
  if (facts.folder && facts.ignored) return 'ignored';
  return null;
}

const bornAt = (stat: fs.Stats) => (stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);

function git(args: string[]) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: 3000, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
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
    const r = git(['-C', win.dirname(p), 'ls-files', '--', p]);
    if (r.status === 0) return r.stdout.trim() !== '';
    // Only "not a git repository" is a clear no; git missing, a timeout or any other failure leaves it unknown, and unknown counts as tracked.
    return !(r.status === 128 && /not a git repository/i.test(r.stderr ?? ''));
  },
  ignored(p) {
    return git(['-C', win.dirname(p), 'check-ignore', '-q', '--', p]).status === 0;
  },
};
