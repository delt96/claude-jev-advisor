import fs from 'node:fs';
import path from 'node:path';
import { parseLines, type Entry } from './context/transcript.js';
import { readLogRecords, type LogRecord } from './log-records.js';
import { localTime, transcriptGone } from './report.js';
import { RM_LOG_COMMAND_CHARS } from './rm/run.js';

export const LIST_LINES = 20;
export const ANSWER_WINDOW_MS = 10 * 60 * 1000;
export const LONG_WAIT_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 60 * 1000;

export type AskAnswer = { kind: 'approved' | 'refused' | 'no_answer' | 'deleted' | 'unknown'; waitMs: number | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const SKIP_NAMES: [string, string][] = [
  ['temp', 'temp'],
  ['build', 'build folder'],
  ['superpowers', '.superpowers'],
  ['missing', 'missing'],
  ['drive', 'other drive'],
  ['whatif', '-WhatIf'],
];
const ASK_PREFIX = '실제 파일 삭제: ';
const REDACTED = '[redacted]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function contentOf(entry: Entry): Record<string, unknown>[] {
  const message = entry.message;
  return isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : [];
}

type EntryCache = Map<string, Entry[] | null>;

function readEntries(file: string, cache: EntryCache): Entry[] | null {
  if (!cache.has(file)) {
    try {
      cache.set(file, parseLines(fs.readFileSync(file, 'utf8')));
    } catch {
      cache.set(file, null);
    }
  }
  return cache.get(file) ?? null;
}

function transcriptEntries(record: LogRecord, cache: EntryCache): Entry[] | null {
  if (typeof record.transcriptPath !== 'string') return null;
  const main = readEntries(record.transcriptPath, cache);
  if (!main) return null;
  const all = [...main];
  if (typeof record.sessionId === 'string') {
    const dir = path.join(path.dirname(record.transcriptPath), record.sessionId, 'subagents');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {}
    for (const name of names) all.push(...(readEntries(path.join(dir, name), cache) ?? []));
  }
  return all;
}

function blockText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c) => (isRecord(c) && typeof c.text === 'string' ? c.text : '')).join(' ') : '';
}

function isRefusal(entry: Entry, block: Record<string, unknown>): boolean {
  if (typeof entry.toolDenialKind === 'string') return true;
  if (isRecord(entry.toolUseResult) && typeof entry.toolUseResult.toolDenialKind === 'string') return true;
  return block.is_error === true && blockText(block).includes("doesn't want to proceed");
}

// The log keeps a command cut to its first characters with API keys replaced, and the keys are not known here, so a
// redacted command matches by its text before the first redaction.
function loggedAs(called: string, logged: unknown): boolean {
  if (typeof logged !== 'string') return false;
  const redacted = logged.indexOf(REDACTED);
  return redacted === -1 ? called.slice(0, RM_LOG_COMMAND_CHARS) === logged : called.startsWith(logged.slice(0, redacted));
}

export function askAnswer(record: LogRecord, cache: EntryCache = new Map()): AskAnswer {
  const entries = transcriptEntries(record, cache);
  if (!entries) {
    const gone = typeof record.transcriptPath === 'string' && typeof record.sessionId === 'string' && transcriptGone(record.transcriptPath, record.sessionId);
    return { kind: gone ? 'deleted' : 'unknown', waitMs: null };
  }
  const askedAt = timeOf(record.at);
  let id = typeof record.toolUseId === 'string' ? record.toolUseId : null;
  if (id === null) {
    let best = Infinity;
    for (const entry of entries) {
      const time = timeOf(entry.timestamp);
      if (!Number.isNaN(askedAt) && !(time >= askedAt - LOOKBACK_MS && time <= askedAt + ANSWER_WINDOW_MS)) continue;
      const call = contentOf(entry).find((c) => c.type === 'tool_use' && (c.name === 'Bash' || c.name === 'PowerShell') && isRecord(c.input) && typeof c.input.command === 'string' && loggedAs(c.input.command, record.command));
      const distance = Number.isNaN(askedAt) ? 0 : Math.abs(time - askedAt);
      if (call && typeof call.id === 'string' && distance < best) {
        id = call.id;
        best = distance;
      }
    }
  }
  if (id !== null) {
    const results: { entry: Entry; block: Record<string, unknown> }[] = [];
    for (const entry of entries) {
      const block = contentOf(entry).find((c) => c.type === 'tool_result' && c.tool_use_id === id);
      if (block) results.push({ entry, block });
    }
    // Some entries repeat a tool_result without a timestamp; a timed one is the real result.
    const found = results.find((r) => !Number.isNaN(timeOf(r.entry.timestamp))) ?? results[0];
    if (found) {
      const wait = timeOf(found.entry.timestamp) - askedAt;
      return { kind: isRefusal(found.entry, found.block) ? 'refused' : 'approved', waitMs: Number.isNaN(wait) || wait < 0 ? null : wait };
    }
  }
  return { kind: 'no_answer', waitMs: null };
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function targetsOf(record: LogRecord): Record<string, unknown>[] {
  return Array.isArray(record.targets) ? record.targets.filter(isRecord) : [];
}

function nameOf(value: unknown): string {
  return path.win32.basename(typeof value === 'string' ? value : '');
}

function liftName(target: Record<string, unknown>, legacy: boolean): string {
  const lift = legacy ? 'jev' : target.lift;
  const name = nameOf(target.shown ?? target.path);
  if (lift === 'git') return `${name} (git)`;
  if (lift === 'copy') return `${name} (copy of ${nameOf(target.copy)})`;
  return `${name} (Jev ${typeof target.p === 'number' ? target.p.toFixed(2) : '?'})`;
}

function stamp(record: LogRecord): string {
  const time = new Date(timeOf(record.at));
  return `    ${localTime(time).slice(5)}  ${String(record.sessionId ?? '').slice(0, 8)}  `;
}

function capped(lines: string[]): string[] {
  return lines.length > LIST_LINES ? [...lines.slice(0, LIST_LINES), `    … ${lines.length - LIST_LINES} more`] : lines;
}

function answerText(answer: AskAnswer): string {
  const after = answer.waitMs === null ? '' : ` after ${duration(answer.waitMs)}`;
  if (answer.kind === 'approved') return `approved${after}`;
  if (answer.kind === 'refused') return `refused${after}`;
  if (answer.kind === 'no_answer') return 'no answer';
  return answer.kind === 'deleted' ? 'session deleted' : 'transcript not found';
}

export function rmReportLines(home: string, now: Date, days: number): string[] {
  const records = readLogRecords(home, new Date(now.getTime() - days * DAY_MS), now).filter((r) => r.helper === 'rm');
  const head = `rm in the last ${days} day${days === 1 ? '' : 's'}`;
  if (!records.length) return [`${head}: nothing recorded`];
  const lines = [`${head}: ${records.length} commands with real targets`];
  const none = records.filter((r) => r.decision === 'none');
  const skipped = none.flatMap((r) => (Array.isArray(r.skipped) ? r.skipped.filter(isRecord) : []));
  if (none.length) {
    const parts = SKIP_NAMES.map(([why, label]) => ({ label, n: skipped.filter((s) => s.why === why).length })).filter((p) => p.n > 0);
    lines.push(`  no decision ${none.length}${parts.length ? `: ${parts.map((p) => `${p.label} ${p.n}`).join(', ')}` : ''}`);
  }
  const passed = records.filter((r) => r.decision === 'pass');
  const asked = records.filter((r) => r.decision === 'ask');
  const blocked = records.filter((r) => r.decision === 'deny');
  const legacy = (r: LogRecord) => !Array.isArray(r.skipped);
  const lifts = passed.flatMap((r) => targetsOf(r).map((t) => (legacy(r) ? 'jev' : t.lift)));
  const liftParts = (['git', 'copy', 'jev'] as const).map((k) => ({ label: k === 'jev' ? 'Jev' : k, n: lifts.filter((l) => l === k).length })).filter((p) => p.n > 0);
  lines.push(`  lifted ${passed.length}${liftParts.length ? `: ${liftParts.map((p) => `${p.label} ${p.n}`).join(', ')}` : ''} · asked ${asked.length} · blocked ${blocked.length}`);
  if (passed.length) {
    lines.push('  lifted:');
    lines.push(...capped(passed.map((r) => `${stamp(r)}${targetsOf(r).map((t) => liftName(t, legacy(r))).join(', ')}`)));
  }
  if (asked.length) {
    const cache: EntryCache = new Map();
    const answers = asked.map((r) => askAnswer(r, cache));
    const count = (kind: AskAnswer['kind']) => answers.filter((a) => a.kind === kind).length;
    const waits = answers.map((a) => a.waitMs).filter((w): w is number => w !== null);
    const mid = median(waits);
    const unanswerable = (['deleted', 'unknown'] as const).flatMap((kind) => (count(kind) ? [`, ${answerText({ kind, waitMs: null })} ${count(kind)}`] : []));
    lines.push(`  asked: approved ${count('approved')}, refused ${count('refused')}, no answer ${count('no_answer')}${unanswerable.join('')}; wait median ${mid === null ? '-' : duration(mid)}, over 10 min ${waits.filter((w) => w > LONG_WAIT_MS).length}`);
    lines.push(
      ...capped(
        asked.map((r, i) => {
          // Records from 0.5.1 have no reason, only the targets.
          const reason = typeof r.reason === 'string' ? r.reason.replace(ASK_PREFIX, '') : targetsOf(r).map((t) => nameOf(t.shown)).join(', ');
          return `${stamp(r)}${reason}  -> ${answerText(answers[i])}`;
        }),
      ),
    );
  }
  return lines;
}
