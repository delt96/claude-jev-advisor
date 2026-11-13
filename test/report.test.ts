import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, type CliIo } from '../src/cli/run.js';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';
import { dataDir, pressDir } from '../src/paths.js';
import { outcomeAfter, reportLines } from '../src/report.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0);
const iso = (daysAgo: number, hour = 9) => new Date(2026, 9, 3 - daysAgo, hour, 0, 0).toISOString();
const request = (at: string, text = 'next') => ({ type: 'user', isSidechain: false, origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: text } });
const compacted = (at: string, trigger: 'manual' | 'auto') => ({ type: 'system', subtype: 'compact_boundary', timestamp: at, compactMetadata: { trigger } });
const clock = (hour: number, minute = 0, second = 0) => new Date(2026, 9, 2, hour, minute, second).toISOString();
const TURNS = { turns: true };

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
  const lines = reportLines(setupHome(), NOW, 7, TURNS);
  assert.equal(lines[0], 'Advice shown in the last 7 days: 6');
  const row = (session: string) => lines.find((l) => l.includes(session.slice(0, 8))) ?? '';
  assert.match(row('sess-sep'), /312k {2}\/compact {2}unit 0\.91 phase 0\.42 {2}"로그인 화면 고쳐 줘" {2}-> compacted$/);
  assert.match(row('sess-com'), /-> compacted$/);
  assert.match(row('sess-cle'), /\/clear .*-> cleared$/);
  assert.match(row('sess-kep'), /-> kept going, 3\+ requests$/);
  assert.match(row('sess-aut'), /-> auto-compacted at the limit$/);
  assert.match(row('sess-leg'), /\/clear {2}unit 0\.90 goal 0\.85 {2}"" {2}-> transcript not found$/);
  assert.equal(lines.some((l) => l.includes('sess-old') || l.includes('sess-non')), false);
  assert.ok(lines.includes('/clear: 2 - compacted 0, cleared 1, compacted while away 0, auto-compacted at the limit 0, kept going 0, session deleted 0, transcript not found 1'));
  assert.ok(lines.includes('/compact: 4 - compacted 2, cleared 0, compacted while away 0, auto-compacted at the limit 1, kept going 1, session deleted 0, transcript not found 0'));
});

test('a manual compact counts only within the next three requests; a /clear only when the session ended by it', () => {
  const from = Date.parse(iso(1));
  const clearAt = Date.parse(iso(1, 12));
  assert.deepEqual(outcomeAfter([request(iso(1, 10)), request(iso(1, 11)), compacted(iso(1, 12), 'manual')], from, null), { kind: 'compact', at: Date.parse(iso(1, 12)) });
  assert.deepEqual(outcomeAfter([request(iso(1, 10)), request(iso(1, 11)), request(iso(1, 12)), compacted(iso(1, 13), 'manual')], from, clearAt), { kind: 'kept', requests: 3 });
  assert.deepEqual(outcomeAfter([request(iso(1, 10))], from, clearAt), { kind: 'clear', at: clearAt });
  assert.deepEqual(outcomeAfter([request(iso(1, 10))], from, null), { kind: 'kept', requests: 1 });
  assert.deepEqual(outcomeAfter([compacted(iso(1, 8), 'manual'), request(iso(1, 7))], from, null), { kind: 'kept', requests: 0 });
});

test('the report command takes --days and refuses bad values', async () => {
  const home = setupHome();
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { home, distDir: 'C:/n/dist', platform: 'win32', now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l), env: {} };
  assert.equal(await runCli(['report', '--days', '2', '--turns'], io), 0);
  assert.equal(out[0], 'Advice shown in the last 2 days: 5');
  assert.equal(await runCli(['report', '--days', '0'], io), 2);
  assert.equal(await runCli(['report', '--since', '3'], io), 2);
  assert.equal(await runCli(['status', '--days', '3'], io), 2);
  assert.match(err.join('\n'), /--days takes a whole number of days from 1/);
});

test('answers that are not numbers are left out of the line instead of breaking the report', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-report-odd-'));
  writeConfig(home, DEFAULT_CONFIG);
  writeJsonl(path.join(dataDir(home), 'log', '2026-10.jsonl'), [stopRecord('sess-odd', iso(1), null, { jev: { answers: { unit_done: 0.91, phase_done: 'x' } } })]);
  const lines = reportLines(home, NOW, 7, TURNS);
  assert.match(lines[1], /\/compact {2}unit 0\.91 {2}"" {2}-> transcript not found$/);
});

function episodeHome(): { home: string; t: (name: string, rows: object[]) => string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-episode-'));
  writeConfig(home, DEFAULT_CONFIG);
  return { home, t: (name, rows) => writeJsonl(path.join(home, 'transcripts', `${name}.jsonl`), rows) };
}

const logOf = (home: string, rows: object[]) => writeJsonl(path.join(dataDir(home), 'log', '2026-10.jsonl'), rows);
const sized = (id: string, when: string, file: string | null, size: number) => stopRecord(id, when, file, { size });
const press = (home: string, sessionId: string, kind: string, when: string) =>
  writeJsonl(path.join(pressDir(home), `${sessionId}-${Date.parse(when)}.json`), [{ sessionId, kind, at: Date.parse(when) }]);

test('advice turns before the same compact form one episode, with the count and both sizes', () => {
  const { home, t } = episodeHome();
  const file = t('a', [request(clock(9, 1)), request(clock(9, 3)), request(clock(9, 5)), compacted(clock(9, 6), 'manual')]);
  logOf(home, [sized('sess-aaaa1111', clock(9, 0), file, 305000), sized('sess-aaaa1111', clock(9, 2), file, 307000), sized('sess-aaaa1111', clock(9, 4), file, 310000)]);
  const lines = reportLines(home, NOW, 7);
  assert.equal(lines[0], 'Advice in the last 7 days: 3 times in 1 episodes, 1 sessions');
  assert.equal(lines.filter((l) => l.includes('sess-aaa')).length, 1);
  assert.match(lines[1], /305k→310k {2}\/compact ×3 .*-> compacted$/);
  assert.match(lines[2], /^Episodes: compacted 1 \(band 0\), /);
});

test('three requests without advice end an episode as kept going, and a later advice starts a new one', () => {
  const { home, t } = episodeHome();
  const file = t('b', [request(clock(9, 1)), request(clock(9, 2)), request(clock(9, 3)), request(clock(9, 5)), compacted(clock(9, 6), 'manual')]);
  logOf(home, [sized('sess-bbbb2222', clock(9, 0), file, 300000), sized('sess-bbbb2222', clock(9, 4), file, 320000)]);
  const lines = reportLines(home, NOW, 7);
  assert.equal(lines[0], 'Advice in the last 7 days: 2 times in 2 episodes, 1 sessions');
  assert.match(lines[1], /300k .*-> kept going, 3\+ requests$/);
  assert.match(lines[2], /320k .*-> compacted$/);
});

test('an auto compact after half an hour of quiet is compacted while away; otherwise at the limit', () => {
  const { home, t } = episodeHome();
  const away = t('away', [request(clock(9, 1)), compacted(clock(9, 53), 'auto')]);
  const near = t('near', [request(clock(9, 1)), compacted(clock(9, 3), 'auto')]);
  logOf(home, [sized('sess-away1111', clock(9, 0), away, 300000), sized('sess-near2222', clock(9, 0), near, 300000)]);
  const lines = reportLines(home, NOW, 7);
  assert.match(lines.find((l) => l.includes('sess-awa')) ?? '', /-> compacted while away$/);
  assert.match(lines.find((l) => l.includes('sess-nea')) ?? '', /-> auto-compacted at the limit$/);
  assert.match(lines.find((l) => l.startsWith('Episodes:')) ?? '', /compacted while away 1, auto-compacted at the limit 1/);
});

test('a deleted session is named; a missing transcript without the release file is not found', () => {
  const { home } = episodeHome();
  const gone = path.join(home, 'transcripts', 'sess-gone1111.jsonl');
  const lost = path.join(home, 'transcripts', 'sess-lost2222.jsonl');
  fs.mkdirSync(path.dirname(gone), { recursive: true });
  fs.writeFileSync(path.join(home, 'transcripts', 'sess-gone1111.desktop-released.json'), '{}');
  logOf(home, [sized('sess-gone1111', clock(9, 0), gone, 300000), sized('sess-lost2222', clock(9, 0), lost, 300000)]);
  const lines = reportLines(home, NOW, 7);
  assert.match(lines.find((l) => l.includes('sess-gon')) ?? '', /-> session deleted$/);
  assert.match(lines.find((l) => l.includes('sess-los')) ?? '', /-> transcript not found$/);
});

test('a press of the same kind between the first advice and the outcome marks the episode (band)', () => {
  const run = (kind: string, when: string) => {
    const { home, t } = episodeHome();
    const file = t('p', [request(clock(9, 1)), compacted(clock(9, 2), 'manual')]);
    logOf(home, [sized('sess-pppp1111', clock(9, 0), file, 300000)]);
    press(home, 'sess-pppp1111', kind, when);
    return reportLines(home, NOW, 7).find((l) => l.includes('sess-ppp')) ?? '';
  };
  assert.match(run('compact', clock(9, 2, 30)), /-> compacted \(band\)$/);
  assert.match(run('clear', clock(9, 2, 30)), /-> compacted$/);
  assert.match(run('compact', clock(9, 4)), /-> compacted$/);
});

test('--turns lists every turn and takes no value', async () => {
  const { home, t } = episodeHome();
  const file = t('c', [request(clock(9, 1)), compacted(clock(9, 3), 'manual')]);
  logOf(home, [
    sized('sess-cccc1111', clock(9, 0), file, 300000),
    sized('sess-cccc1111', clock(9, 2), file, 305000),
    { at: clock(9, 5), helper: 'rm', event: 'pre_tool_use', sessionId: 'sess-cccc1111', decision: 'ask', targets: [] },
  ]);
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { home, distDir: 'C:/n/dist', platform: 'win32', now: () => NOW, out: (l) => out.push(l), err: (l) => err.push(l), env: {} };
  assert.equal(await runCli(['report', '--turns'], io), 0);
  assert.equal(out.filter((l) => /^ {2}\d{4}-.*sess-ccc/.test(l)).length, 2);
  assert.equal(await runCli(['report', '--turns', '3'], io), 2);
  assert.match(err.join('\n'), /unknown helper "3"/);
  assert.equal(await runCli(['report', '--days', '0'], io), 2);
});
