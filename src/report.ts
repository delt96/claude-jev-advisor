import fs from 'node:fs';
import path from 'node:path';
import { readConfig, type Config } from './config.js';
import { isRequest, parseLines, requestText, type Entry } from './context/transcript.js';
import { adviceKind, formatSize, parseState, type AdviceKind } from './display/line.js';
import { readLogRecords, type LogRecord } from './log-records.js';
import { pressDir } from './paths.js';
import { rmReportLines } from './report-rm.js';

export type Outcome =
  | { kind: 'compact' | 'clear' | 'auto_compact' | 'idle_compact'; at: number }
  | { kind: 'kept'; requests: number }
  | { kind: 'deleted' }
  | { kind: 'unknown' };
export type AdviceRow = {
  at: Date;
  sessionId: string;
  size: number;
  advice: AdviceKind;
  answers: Record<string, number> | null;
  request: string;
  outcome: Outcome;
  requestTimes: number[];
};
export type Episode = { sessionId: string; rows: AdviceRow[]; outcome: Outcome; band: boolean };

export const FOLLOW_REQUESTS = 3;
export const IDLE_GAP_MS = 30 * 60 * 1000;
export const BAND_GRACE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function adviceOf(record: LogRecord, config: Config): AdviceKind | null {
  if ('advice' in record) return record.advice === 'clear' || record.advice === 'compact' ? record.advice : null;
  // Records written before 0.2.0 do not say which advice was shown; it is worked out again with today's thresholds.
  const state = parseState({ sessionId: record.sessionId, at: 0, size: record.size, judgment: record.judgment });
  return state ? adviceKind(state.size, state.judgment, config) : null;
}

function entryTime(entry: Entry): number {
  return typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
}

export function outcomeAfter(entries: Entry[], at: number, clearAt: number | null): Outcome {
  let requests = 0;
  let previous = NaN;
  for (const entry of entries) {
    const time = entryTime(entry);
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && time > at) {
      const trigger = isRecord(entry.compactMetadata) ? entry.compactMetadata.trigger : undefined;
      if (trigger !== 'auto') return { kind: 'compact', at: time };
      return { kind: time - previous >= IDLE_GAP_MS ? 'idle_compact' : 'auto_compact', at: time };
    }
    if (time > at && isRequest(entry) && requestText(entry)) {
      requests += 1;
      if (requests >= FOLLOW_REQUESTS) return { kind: 'kept', requests };
    }
    if (!Number.isNaN(time)) previous = time;
  }
  return clearAt !== null ? { kind: 'clear', at: clearAt } : { kind: 'kept', requests };
}

export function transcriptGone(file: string, sessionId: string): boolean {
  return fs.existsSync(path.join(path.dirname(file), `${sessionId}.desktop-released.json`));
}

export function adviceRows(home: string, now: Date, days: number): AdviceRow[] {
  const config = readConfig(home);
  const records = readLogRecords(home, new Date(now.getTime() - days * DAY_MS), now);
  const clears = new Map<string, number[]>();
  for (const r of records) {
    if (r.event !== 'session_end' || r.reason !== 'clear' || typeof r.sessionId !== 'string' || typeof r.at !== 'string') continue;
    clears.set(r.sessionId, [...(clears.get(r.sessionId) ?? []), Date.parse(r.at)]);
  }
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
    const clearAt = (clears.get(record.sessionId) ?? []).filter((t) => t > at.getTime()).sort((x, y) => x - y)[0] ?? null;
    const gone = !entries && typeof record.transcriptPath === 'string' && transcriptGone(record.transcriptPath, record.sessionId);
    rows.push({
      at,
      sessionId: record.sessionId,
      size: record.size,
      advice,
      answers: isRecord(jev.answers) ? (jev.answers as Record<string, number>) : null,
      request: typeof last === 'string' ? last : '',
      outcome: entries ? outcomeAfter(entries, at.getTime(), clearAt) : gone ? { kind: 'deleted' } : { kind: 'unknown' },
      requestTimes: (entries ?? []).filter((e) => isRequest(e) && requestText(e)).map(entryTime).filter((t) => !Number.isNaN(t)),
    });
  }
  return rows;
}

type Press = { sessionId: string; kind: string; at: number };

function readPresses(home: string): Press[] {
  let names: string[];
  try {
    names = fs.readdirSync(pressDir(home));
  } catch {
    return [];
  }
  const presses: Press[] = [];
  for (const name of names) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(pressDir(home), name), 'utf8'));
      if (isRecord(value) && typeof value.sessionId === 'string' && typeof value.kind === 'string' && typeof value.at === 'number') {
        presses.push({ sessionId: value.sessionId, kind: value.kind, at: value.at });
      }
    } catch {}
  }
  return presses;
}

type EventOutcome = Extract<Outcome, { at: number }>;

function isEvent(outcome: Outcome): outcome is EventOutcome {
  return 'at' in outcome;
}

function startsNewEpisode(previous: AdviceRow, row: AdviceRow): boolean {
  const before = previous.outcome;
  const after = row.outcome;
  if (isEvent(before) && !(isEvent(after) && after.kind === before.kind && after.at === before.at)) return true;
  const times = row.requestTimes.length ? row.requestTimes : previous.requestTimes;
  return times.filter((t) => t > previous.at.getTime() && t < row.at.getTime()).length >= FOLLOW_REQUESTS;
}

function episodesOf(rows: AdviceRow[], presses: Press[]): Episode[] {
  const bySession = new Map<string, AdviceRow[]>();
  for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
  const episodes: Episode[] = [];
  for (const [sessionId, list] of bySession) {
    let current: AdviceRow[] = [];
    const close = () => {
      if (!current.length) return;
      const outcome = current[current.length - 1].outcome;
      const band =
        (outcome.kind === 'compact' || outcome.kind === 'clear') &&
        presses.some((p) => p.sessionId === sessionId && p.kind === outcome.kind && p.at >= current[0].at.getTime() && p.at <= outcome.at + BAND_GRACE_MS);
      episodes.push({ sessionId, rows: current, outcome, band });
    };
    for (const row of list) {
      if (current.length && startsNewEpisode(current[current.length - 1], row)) {
        close();
        current = [];
      }
      current.push(row);
    }
    close();
  }
  return episodes.sort((a, b) => a.rows[0].at.getTime() - b.rows[0].at.getTime());
}

export function localTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

const OUTCOME_NAMES = {
  compact: 'compacted',
  clear: 'cleared',
  idle_compact: 'compacted while away',
  auto_compact: 'auto-compacted at the limit',
  kept: 'kept going',
  deleted: 'session deleted',
  unknown: 'transcript not found',
} as const;

function outcomeText(outcome: Outcome): string {
  if (outcome.kind !== 'kept') return OUTCOME_NAMES[outcome.kind];
  return outcome.requests >= FOLLOW_REQUESTS ? `kept going, ${FOLLOW_REQUESTS}+ requests` : `kept going, ${outcome.requests} request${outcome.requests === 1 ? '' : 's'}`;
}

function answersText(answers: Record<string, number> | null): string {
  if (!answers) return '';
  return Object.entries(answers)
    .filter(([, p]) => typeof p === 'number')
    .map(([id, p]) => `${id.replace(/_done$/, '')} ${p.toFixed(2)}`)
    .join(' ');
}

function shortRequest(row: AdviceRow): string {
  return row.request.replace(/\s+/g, ' ').trim().slice(0, 40);
}

function turnLines(rows: AdviceRow[]): string[] {
  const lines = rows.map(
    (row) => `  ${localTime(row.at)}  ${row.sessionId.slice(0, 8)}  ${formatSize(row.size)}  /${row.advice}  ${answersText(row.answers)}  "${shortRequest(row)}"  -> ${outcomeText(row.outcome)}`,
  );
  for (const advice of ['clear', 'compact'] as const) {
    const mine = rows.filter((r) => r.advice === advice);
    if (!mine.length) continue;
    const names = (Object.keys(OUTCOME_NAMES) as (keyof typeof OUTCOME_NAMES)[]).map((k) => `${OUTCOME_NAMES[k]} ${mine.filter((r) => r.outcome.kind === k).length}`);
    lines.push(`/${advice}: ${mine.length} - ${names.join(', ')}`);
  }
  return lines;
}

function kindsText(rows: AdviceRow[]): string {
  return (['compact', 'clear'] as const)
    .map((kind) => ({ kind, n: rows.filter((r) => r.advice === kind).length }))
    .filter((k) => k.n > 0)
    .map((k) => `/${k.kind}${k.n > 1 ? ` ×${k.n}` : ''}`)
    .join(', ');
}

function episodeLines(episodes: Episode[]): string[] {
  const lines = episodes.map((episode) => {
    const first = episode.rows[0];
    const last = episode.rows[episode.rows.length - 1];
    const size = first.size === last.size ? formatSize(last.size) : `${formatSize(first.size)}→${formatSize(last.size)}`;
    const band = episode.band ? ' (band)' : '';
    return `  ${localTime(first.at).slice(5)}  ${episode.sessionId.slice(0, 8)}  ${size}  ${kindsText(episode.rows)}  ${answersText(last.answers)}  "${shortRequest(last)}"  -> ${outcomeText(episode.outcome)}${band}`;
  });
  const count = (kind: Outcome['kind']) => episodes.filter((e) => e.outcome.kind === kind).length;
  const banded = (kind: Outcome['kind']) => episodes.filter((e) => e.outcome.kind === kind && e.band).length;
  lines.push(
    `Episodes: compacted ${count('compact')} (band ${banded('compact')}), cleared ${count('clear')} (band ${banded('clear')}), compacted while away ${count('idle_compact')}, auto-compacted at the limit ${count('auto_compact')}, kept going ${count('kept')}, session deleted ${count('deleted')}, transcript not found ${count('unknown')}`,
  );
  return lines;
}

export function reportLines(home: string, now: Date, days: number, options: { turns?: boolean } = {}): string[] {
  const rows = adviceRows(home, now, days);
  const span = `${days} day${days === 1 ? '' : 's'}`;
  if (options.turns) return [`Advice shown in the last ${span}: ${rows.length}`, ...turnLines(rows), ...rmReportLines(home, now, days)];
  const episodes = episodesOf(rows, readPresses(home));
  const sessions = new Set(rows.map((r) => r.sessionId)).size;
  return [`Advice in the last ${span}: ${rows.length} times in ${episodes.length} episodes, ${sessions} sessions`, ...episodeLines(episodes), ...rmReportLines(home, now, days)];
}
