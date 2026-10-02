import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/run.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';
import { dataDir } from '../src/paths.js';
import { outcomeAfter, reportLines } from '../src/report.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0);
const iso = (daysAgo: number, hour = 9) => new Date(2026, 9, 3 - daysAgo, hour, 0, 0).toISOString();
const request = (at: string, text = 'next') => ({ type: 'user', isSidechain: false, origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: text } });
const compacted = (at: string, trigger: 'manual' | 'auto') => ({ type: 'system', subtype: 'compact_boundary', timestamp: at, compactMetadata: { trigger } });

function writeJsonl(file: string, rows: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

function stopRecord(sessionId: string, at: string, transcriptPath: string | null, extra: object = {}) {
  return {
    at,
    helper: 'context',
    event: 'stop',
    sessionId,
    transcriptPath,
    size: 312000,
    judgment: { phase: 'unit_done', clear: false },
    advice: 'compact',
    jev: { state: { recent_requests: ['old', '로그인 화면\n고쳐 줘'] }, answers: { unit_done: 0.91, phase_done: 0.42 } },
    ...extra,
  };
}

function setupHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-report-'));
  writeConfig(home, DEFAULT_CONFIG);
  const t = (name: string, rows: object[]) => writeJsonl(path.join(home, 'transcripts', `${name}.jsonl`), rows);
  const at = iso(1);
  const later = (hour: number) => iso(1, hour);
  writeJsonl(path.join(dataDir(home), 'log', '2026-09.jsonl'), [
    stopRecord('sess-old', iso(10), null),
    stopRecord('sess-sep', iso(4), t('sep', [request(iso(4, 10)), compacted(iso(4, 11), 'manual')])),
  ]);
  writeJsonl(path.join(dataDir(home), 'log', '2026-10.jsonl'), [
    stopRecord('sess-compact', at, t('compact', [request(at), compacted(later(10), 'manual'), request(later(11))])),
    stopRecord('sess-clear', at, t('clear', [request(later(10))]), { advice: 'clear', judgment: { phase: 'unit_done', clear: true } }),
    { at: later(12), helper: 'context', event: 'session_end', sessionId: 'sess-clear', reason: 'clear' },
    stopRecord('sess-kept', at, t('kept', [request(later(10)), request(later(11)), request(later(12)), compacted(later(13), 'manual')])),
    stopRecord('sess-auto', at, t('auto', [compacted(later(10), 'auto')])),
    stopRecord('sess-none', at, null, { advice: null, judgment: { phase: 'working', clear: false } }),
    { ...stopRecord('sess-legacy', at, path.join(home, 'gone.jsonl'), { judgment: { phase: 'unit_done', clear: true }, jev: { answers: { unit_done: 0.9, goal_done: 0.85 } } }), advice: undefined },
  ]);
  return home;
}

test('each piece of advice gets one line with what followed, and totals per kind', () => {
  const lines = reportLines(setupHome(), NOW, 7);
  assert.equal(lines[0], 'Advice shown in the last 7 days: 6');
  const row = (session: string) => lines.find((l) => l.includes(session.slice(0, 8))) ?? '';
  assert.match(row('sess-sep'), /312k {2}\/compact {2}unit 0\.91 phase 0\.42 {2}"로그인 화면 고쳐 줘" {2}-> compacted$/);
  assert.match(row('sess-com'), /-> compacted$/);
  assert.match(row('sess-cle'), /\/clear .*-> cleared$/);
  assert.match(row('sess-kep'), /-> kept going, 3\+ requests$/);
  assert.match(row('sess-aut'), /-> auto-compacted$/);
  assert.match(row('sess-leg'), /\/clear {2}unit 0\.90 goal 0\.85 {2}"" {2}-> transcript not found$/);
  assert.equal(lines.some((l) => l.includes('sess-old') || l.includes('sess-non')), false);
  assert.ok(lines.includes('/clear: 2 - compacted 0, cleared 1, auto-compacted 0, kept going 0, unknown 1'));
  assert.ok(lines.includes('/compact: 4 - compacted 2, cleared 0, auto-compacted 1, kept going 1, unknown 0'));
});

test('a manual compact counts only within the next three requests; a /clear only when the session ended by it', () => {
  const at = Date.parse(iso(1));
  assert.deepEqual(outcomeAfter([request(iso(1, 10)), request(iso(1, 11)), compacted(iso(1, 12), 'manual')], at, false), { kind: 'compact' });
  assert.deepEqual(outcomeAfter([request(iso(1, 10)), request(iso(1, 11)), request(iso(1, 12)), compacted(iso(1, 13), 'manual')], at, true), { kind: 'kept', requests: 3 });
  assert.deepEqual(outcomeAfter([request(iso(1, 10))], at, true), { kind: 'clear' });
  assert.deepEqual(outcomeAfter([request(iso(1, 10))], at, false), { kind: 'kept', requests: 1 });
  assert.deepEqual(outcomeAfter([compacted(iso(1, 8), 'manual'), request(iso(1, 7))], at, false), { kind: 'kept', requests: 0 });
});

test('the report command takes --days and refuses bad values', async () => {
  const home = setupHome();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { home, distDir: 'C:/n/dist', platform: 'win32', now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l), env: {} };
  assert.equal(await runCli(['report', '--days', '2'], io), 0);
  assert.equal(out[0], 'Advice shown in the last 2 days: 5');
  assert.equal(await runCli(['report', '--days', '0'], io), 2);
  assert.equal(await runCli(['report', '--since', '3'], io), 2);
  assert.equal(await runCli(['status', '--days', '3'], io), 2);
  assert.match(err.join('\n'), /--days takes a whole number of days from 1/);
});
