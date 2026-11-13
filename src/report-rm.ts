import fs from 'node:fs';
import path from 'node:path';
import { parseLines, type Entry } from './context/transcript.js';
import { readLogRecords, type LogRecord } from './log-records.js';
import { localTime, transcriptGone } from './report.js';

export const LIST_LINES = 20;
export const ANSWER_WINDOW_MS = 10 * 60 * 1000;
export const LONG_WAIT_MS = 10 * 60 * 1000;

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

function readEntries(file: string): Entry[] | null {
  try {
    return parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function transcriptSet(record: LogRecord): Entry[][] | null {
  if (typeof record.transcriptPath !== 'string') return null;
  const main = readEntries(record.transcriptPath);
  if (!main) return null;
  const sets = [main];
  if (typeof record.sessionId === 'string') {
    const dir = path.join(path.dirname(record.transcriptPath), record.sessionId, 'subagents');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {}
    for (const name of names) {
      const entries = readEntries(path.join(dir, name));
      if (entries) sets.push(entries);
    }
  }
  return sets;
}

export function askAnswer(record: LogRecord): AskAnswer {
  const sets = transcriptSet(record);
  if (!sets) {
    const gone = typeof record.transcriptPath === 'string' && typeof record.sessionId === 'string' && transcriptGone(record.transcriptPath, record.sessionId);
    return { kind: gone ? 'deleted' : 'unknown', waitMs: null };
  }
  const entries = sets.flat();
  const askedAt = timeOf(record.at);
  let id = typeof record.toolUseId === 'string' ? record.toolUseId : null;
  if (id === null) {
    // The tool_use entry can be written a moment before the hook runs, so the window reaches back as well.
    for (const entry of entries) {
      const time = timeOf(entry.timestamp);
      if (!Number.isNaN(askedAt) && !(Math.abs(time - askedAt) <= ANSWER_WINDOW_MS)) continue;
      const call = contentOf(entry).find((c) => c.type === 'tool_use' && (c.name === 'Bash' || c.name === 'PowerShell') && isRecord(c.input) && c.input.command === record.command);
      if (call && typeof call.id === 'string') {
        id = call.id;
        break;
      }
    }
  }
  if (id !== null) {
    for (const entry of entries) {
      if (!contentOf(entry).some((c) => c.type === 'tool_result' && c.tool_use_id === id)) continue;
      const refused = isRecord(entry.toolUseResult) && typeof entry.toolUseResult.toolDenialKind === 'string';
      const wait = timeOf(entry.timestamp) - askedAt;
      return { kind: refused ? 'refused' : 'approved', waitMs: Number.isNaN(wait) ? null : Math.max(0, wait) };
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
    const answers = asked.map((r) => askAnswer(r));
    const count = (kind: AskAnswer['kind']) => answers.filter((a) => a.kind === kind).length;
    const waits = answers.map((a) => a.waitMs).filter((w): w is number => w !== null);
    const mid = median(waits);
    lines.push(`  asked: approved ${count('approved')}, refused ${count('refused')}, no answer ${count('no_answer')}; wait median ${mid === null ? '-' : duration(mid)}, over 10 min ${waits.filter((w) => w > LONG_WAIT_MS).length}`);
    lines.push(
      ...capped(
        asked.map((r, i) => {
          const reason = typeof r.reason === 'string' ? r.reason.replace(ASK_PREFIX, '') : '';
          return `${stamp(r)}${reason}  -> ${answerText(answers[i])}`;
        }),
      ),
    );
  }
  return lines;
}
