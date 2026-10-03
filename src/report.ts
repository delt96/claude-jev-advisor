import fs from 'node:fs';
import path from 'node:path';
import { readConfig, type Config } from './config.js';
import { isRequest, parseLines, requestText, type Entry } from './context/transcript.js';
import { adviceKind, formatSize, parseState, type AdviceKind } from './display/line.js';
import { logDir } from './paths.js';

export type Outcome = { kind: 'compact' | 'clear' | 'auto_compact' } | { kind: 'kept'; requests: number } | { kind: 'unknown' };
export type AdviceRow = {
  at: Date;
  sessionId: string;
  size: number;
  advice: AdviceKind;
  answers: Record<string, number> | null;
  request: string;
  outcome: Outcome;
};

export const FOLLOW_REQUESTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

type LogRecord = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function monthFiles(home: string, since: Date, now: Date): string[] {
  const files: string[] = [];
  for (let d = new Date(since.getFullYear(), since.getMonth(), 1); d <= now; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    files.push(path.join(logDir(home), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`));
  }
  return files;
}

export function readLogRecords(home: string, since: Date, now: Date): LogRecord[] {
  const records: LogRecord[] = [];
  for (const file of monthFiles(home, since, now)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const record of parseLines(text)) {
      const at = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
      if (at >= since.getTime() && at <= now.getTime()) records.push(record);
    }
  }
  return records;
}

function adviceOf(record: LogRecord, config: Config): AdviceKind | null {
  if ('advice' in record) return record.advice === 'clear' || record.advice === 'compact' ? record.advice : null;
  // Records written before 0.2.0 do not say which advice was shown; it is worked out again with today's thresholds.
  const state = parseState({ sessionId: record.sessionId, at: 0, size: record.size, judgment: record.judgment });
  return state ? adviceKind(state.size, state.judgment, config) : null;
}

export function outcomeAfter(entries: Entry[], at: number, endedByClear: boolean): Outcome {
  let requests = 0;
  for (const entry of entries) {
    const time = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!(time > at)) continue;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const trigger = isRecord(entry.compactMetadata) ? entry.compactMetadata.trigger : undefined;
      return { kind: trigger === 'auto' ? 'auto_compact' : 'compact' };
    }
    if (isRequest(entry) && requestText(entry)) {
      requests += 1;
      if (requests >= FOLLOW_REQUESTS) return { kind: 'kept', requests };
    }
  }
  return endedByClear ? { kind: 'clear' } : { kind: 'kept', requests };
}

export function adviceRows(home: string, now: Date, days: number): AdviceRow[] {
  const config = readConfig(home);
  const records = readLogRecords(home, new Date(now.getTime() - days * DAY_MS), now);
  const cleared = new Set(records.filter((r) => r.event === 'session_end' && r.reason === 'clear').map((r) => r.sessionId));
  const transcripts = new Map<string, Entry[] | null>();
  const entriesOf = (file: unknown): Entry[] | null => {
    if (typeof file !== 'string') return null;
    if (!transcripts.has(file)) {
      try {
        transcripts.set(file, parseLines(fs.readFileSync(file, 'utf8')));
      } catch {
        transcripts.set(file, null);
      }
    }
    return transcripts.get(file) ?? null;
  };
  const rows: AdviceRow[] = [];
  for (const record of records) {
    if (record.helper !== 'context' || record.event !== 'stop' || typeof record.sessionId !== 'string' || typeof record.size !== 'number') continue;
    const advice = adviceOf(record, config);
    if (!advice) continue;
    const at = new Date(record.at as string);
    const entries = entriesOf(record.transcriptPath);
    const jev = isRecord(record.jev) ? record.jev : {};
    const state = isRecord(jev.state) ? jev.state : {};
    const requests = Array.isArray(state.recent_requests) ? state.recent_requests : [];
    const last = requests[requests.length - 1];
    rows.push({
      at,
      sessionId: record.sessionId,
      size: record.size,
      advice,
      answers: isRecord(jev.answers) ? (jev.answers as Record<string, number>) : null,
      request: typeof last === 'string' ? last : '',
      outcome: entries ? outcomeAfter(entries, at.getTime(), cleared.has(record.sessionId)) : { kind: 'unknown' },
    });
  }
  return rows;
}

function localTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

function outcomeText(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'compact':
      return 'compacted';
    case 'clear':
      return 'cleared';
    case 'auto_compact':
      return 'auto-compacted';
    case 'kept':
      return outcome.requests >= FOLLOW_REQUESTS ? `kept going, ${FOLLOW_REQUESTS}+ requests` : `kept going, ${outcome.requests} request${outcome.requests === 1 ? '' : 's'}`;
    default:
      return 'transcript not found';
  }
}

function answersText(answers: Record<string, number> | null): string {
  if (!answers) return '';
  return Object.entries(answers)
    .filter(([, p]) => typeof p === 'number')
    .map(([id, p]) => `${id.replace(/_done$/, '')} ${p.toFixed(2)}`)
    .join(' ');
}

export function rmLines(home: string, now: Date, days: number): string[] {
  const records = readLogRecords(home, new Date(now.getTime() - days * DAY_MS), now).filter((r) => r.helper === 'rm');
  const passed = records.filter((r) => r.decision === 'pass');
  const lines = [`rm deletions Jev let through: ${passed.length} (asked anyway after a Jev check: ${records.length - passed.length})`];
  for (const record of passed) {
    const targets = Array.isArray(record.targets) ? record.targets.filter(isRecord) : [];
    const listed = targets.map((t) => `${String(t.shown)} (${typeof t.p === 'number' ? t.p.toFixed(2) : '?'})`).join(', ');
    lines.push(`  ${localTime(new Date(record.at as string))}  ${String(record.sessionId ?? '').slice(0, 8)}  ${listed}`);
  }
  return lines;
}

export function reportLines(home: string, now: Date, days: number): string[] {
  const rows = adviceRows(home, now, days);
  const lines = [`Advice shown in the last ${days} day${days === 1 ? '' : 's'}: ${rows.length}`];
  for (const row of rows) {
    const request = row.request.replace(/\s+/g, ' ').trim().slice(0, 40);
    lines.push(`  ${localTime(row.at)}  ${row.sessionId.slice(0, 8)}  ${formatSize(row.size)}  /${row.advice}  ${answersText(row.answers)}  "${request}"  -> ${outcomeText(row.outcome)}`);
  }
  for (const advice of ['clear', 'compact'] as const) {
    const mine = rows.filter((r) => r.advice === advice);
    if (!mine.length) continue;
    const count = (kind: Outcome['kind']) => mine.filter((r) => r.outcome.kind === kind).length;
    lines.push(
      `/${advice}: ${mine.length} - compacted ${count('compact')}, cleared ${count('clear')}, auto-compacted ${count('auto_compact')}, kept going ${count('kept')}, unknown ${count('unknown')}`,
    );
  }
  return [...lines, ...rmLines(home, now, days)];
}
