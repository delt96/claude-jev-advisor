import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.js';
import { dataDir } from '../src/paths.js';
import { reportLines } from '../src/report.js';
import { askAnswer, rmReportLines } from '../src/report-rm.js';

const NOW = new Date(2026, 9, 3, 12, 0, 0);
const at = (hour: number, minute = 0, second = 0) => new Date(2026, 9, 2, hour, minute, second).toISOString();

function writeJsonl(file: string, rows: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

function newHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cja-report-rm-'));
  writeConfig(home, DEFAULT_CONFIG);
  return home;
}

const logOf = (home: string, rows: object[]) => writeJsonl(path.join(dataDir(home), 'log', '2026-10.jsonl'), rows);

function rmRecord(when: string, extra: object = {}) {
  return { at: when, helper: 'rm', event: 'pre_tool_use', sessionId: 'sess-rm-0001', tool: 'Bash', command: 'rm x', cwd: 'C:\\p', decision: 'ask', reason: '실제 파일 삭제: notes.md', targets: [], skipped: [], ...extra };
}

const toolUse = (when: string, id: string, command: string) => ({ type: 'assistant', timestamp: when, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResult = (when: string, id: string, extra: object = {}) => ({ type: 'user', timestamp: when, message: { content: [{ type: 'tool_result', tool_use_id: id }] }, ...extra });
const find = (lines: string[], needle: string) => lines.find((l) => l.includes(needle)) ?? '';

test('decisions are counted by kind and passed-over targets by reason', () => {
  const home = newHome();
  logOf(home, [
    rmRecord(at(9), { decision: 'none', skipped: [{ shown: 'C:\\t\\a', why: 'temp' }, { shown: 'C:\\t\\b', why: 'temp' }, { shown: 'dist', why: 'build' }] }),
    rmRecord(at(9, 1), { decision: 'none', skipped: [{ shown: 'gone', why: 'missing' }] }),
    rmRecord(at(9, 2), { decision: 'pass', targets: [{ shown: 'C:\\p\\a.txt', path: 'C:\\p\\a.txt', lift: 'git' }, { shown: 'C:\\p\\out.json', path: 'C:\\p\\out.json', lift: 'jev', p: 0.91 }] }),
    rmRecord(at(9, 3)),
    rmRecord(at(9, 4), { decision: 'deny' }),
  ]);
  const lines = rmReportLines(home, NOW, 7);
  assert.equal(lines[0], 'rm in the last 7 days: 5 commands with real targets');
  assert.equal(lines[1], '  no decision 2: temp 2, build folder 1, missing 1');
  assert.equal(lines[2], '  lifted 1: git 1, Jev 1 · asked 1 · blocked 1');
  assert.equal(lines[3], '  lifted:');
  assert.match(lines[4], /^ {4}\d{2}-\d{2} \d{2}:\d{2} {2}sess-rm- {2}a\.txt \(git\), out\.json \(Jev 0\.91\)$/);
});

test('nothing recorded is said plainly', () => {
  assert.deepEqual(rmReportLines(newHome(), NOW, 1), ['rm in the last 1 day: nothing recorded']);
});

test('an ask is matched to its result by tool use id, also in a subagent transcript, and by command text without an id', () => {
  const home = newHome();
  const main = writeJsonl(path.join(home, 'transcripts', 'sess-rm-0001.jsonl'), [
    toolUse(at(9), 'tu-1', 'rm one'),
    toolResult(at(9, 2), 'tu-1'),
    toolUse(at(11), 'tu-3', 'rm three'),
    toolResult(at(11, 0, 40), 'tu-3'),
  ]);
  writeJsonl(path.join(home, 'transcripts', 'sess-rm-0001', 'subagents', 'agent-x.jsonl'), [toolUse(at(10), 'tu-2', 'rm two'), toolResult(at(10, 0, 15), 'tu-2')]);
  logOf(home, [
    rmRecord(at(9), { transcriptPath: main, toolUseId: 'tu-1', command: 'rm one' }),
    rmRecord(at(10), { transcriptPath: main, toolUseId: 'tu-2', command: 'rm two' }),
    rmRecord(at(11), { transcriptPath: main, command: 'rm three' }),
  ]);
  const lines = rmReportLines(home, NOW, 7);
  assert.ok(lines.includes('  asked: approved 3, refused 0, no answer 0; wait median 40s, over 10 min 0'));
  assert.match(find(lines, '09:00'), /notes\.md {2}-> approved after 2m$/);
  assert.match(find(lines, '10:00'), /-> approved after 15s$/);
  assert.match(find(lines, '11:00'), /-> approved after 40s$/);
});

test('a refused ask, an ask with no result, and a deleted session are named', () => {
  const home = newHome();
  const main = writeJsonl(path.join(home, 'transcripts', 'sess-rm-0001.jsonl'), [
    toolUse(at(9), 'tu-1', 'rm one'),
    toolResult(at(9, 0, 15), 'tu-1', { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' }),
    toolUse(at(10), 'tu-2', 'rm two'),
  ]);
  const released = path.join(home, 'other', 'sess-rm-0001.jsonl');
  fs.mkdirSync(path.dirname(released), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(released), 'sess-rm-0001.desktop-released.json'), '{}');
  logOf(home, [
    rmRecord(at(9), { transcriptPath: main, toolUseId: 'tu-1' }),
    rmRecord(at(10), { transcriptPath: main, toolUseId: 'tu-2' }),
    rmRecord(at(11), { transcriptPath: released, toolUseId: 'tu-3' }),
    rmRecord(at(12), { transcriptPath: path.join(home, 'nowhere.jsonl'), toolUseId: 'tu-4' }),
  ]);
  const lines = rmReportLines(home, NOW, 7);
  assert.match(find(lines, '09:00'), /-> refused after 15s$/);
  assert.match(find(lines, '10:00'), /-> no answer$/);
  assert.match(find(lines, '11:00'), /-> session deleted$/);
  assert.match(find(lines, '12:00'), /-> transcript not found$/);
  assert.ok(lines.includes('  asked: approved 0, refused 1, no answer 1; wait median 15s, over 10 min 0'));
});

test('askAnswer reports the kind and the wait', () => {
  const home = newHome();
  const main = writeJsonl(path.join(home, 't.jsonl'), [toolUse(at(9), 'tu-1', 'rm one'), toolResult(at(9, 11), 'tu-1')]);
  assert.deepEqual(askAnswer(rmRecord(at(9), { transcriptPath: main, toolUseId: 'tu-1' })), { kind: 'approved', waitMs: 11 * 60 * 1000 });
  assert.deepEqual(askAnswer(rmRecord(at(9), { transcriptPath: null })), { kind: 'unknown', waitMs: null });
});

test('records from 0.5.1 count as Jev lifts and asks', () => {
  const home = newHome();
  logOf(home, [
    { at: at(9), helper: 'rm', event: 'pre_tool_use', sessionId: 'sess-rm-0001', decision: 'pass', targets: [{ shown: 'out.json', p: 0.93 }], jev: [] },
    { at: at(10), helper: 'rm', event: 'pre_tool_use', sessionId: 'sess-rm-0001', decision: 'ask', targets: [{ shown: 'notes.md', p: 0.3 }] },
  ]);
  const lines = rmReportLines(home, NOW, 7);
  assert.ok(lines.includes('  lifted 1: Jev 1 · asked 1 · blocked 0'));
  assert.match(find(lines, '09:00'), /out\.json \(Jev 0\.93\)$/);
});

test('long lists stop at twenty lines', () => {
  const home = newHome();
  logOf(home, Array.from({ length: 25 }, (_, i) => rmRecord(at(8, i))));
  const lines = rmReportLines(home, NOW, 7);
  const start = lines.findIndex((l) => l.startsWith('  asked:'));
  assert.equal(lines.slice(start + 1).length, 21);
  assert.equal(lines[lines.length - 1], '    … 5 more');
});

test('the report shows the rm section in both modes', () => {
  const home = newHome();
  logOf(home, [rmRecord(at(9))]);
  assert.ok(reportLines(home, NOW, 7).includes('rm in the last 7 days: 1 commands with real targets'));
  assert.ok(reportLines(home, NOW, 7, { turns: true }).includes('rm in the last 7 days: 1 commands with real targets'));
});

test('a refusal is read from the top-level denial kind, a nested one, or the rejection text of an error result', () => {
  const home = newHome();
  const rejected = { type: 'user', timestamp: at(9, 0, 5), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-3', is_error: true, content: [{ type: 'text', text: "The user doesn't want to proceed with this tool use." }] }] } };
  const hookError = { type: 'user', timestamp: at(9, 0, 5), message: { content: [{ type: 'tool_result', tool_use_id: 'tu-4', is_error: true, content: 'hook failed' }] } };
  const main = writeJsonl(path.join(home, 't.jsonl'), [
    toolResult(at(9, 0, 5), 'tu-1', { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' }),
    toolResult(at(9, 0, 5), 'tu-2', { toolUseResult: { toolDenialKind: 'user-rejected' } }),
    rejected,
    hookError,
  ]);
  const kind = (id: string) => askAnswer(rmRecord(at(9), { transcriptPath: main, toolUseId: id })).kind;
  assert.deepEqual(['tu-1', 'tu-2', 'tu-3', 'tu-4'].map(kind), ['refused', 'refused', 'refused', 'approved']);
});

test('the same command run twice is matched to the call nearest the ask, and a negative wait is unknown', () => {
  const home = newHome();
  const main = writeJsonl(path.join(home, 't.jsonl'), [
    toolUse(at(9), 'tu-1', 'rm -rf dist'),
    toolResult(at(9, 0, 10), 'tu-1', { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' }),
    toolUse(at(9, 3), 'tu-2', 'rm -rf dist'),
    toolResult(at(9, 3, 20), 'tu-2'),
  ]);
  const first = askAnswer(rmRecord(at(9), { transcriptPath: main, command: 'rm -rf dist' }));
  const second = askAnswer(rmRecord(at(9, 3), { transcriptPath: main, command: 'rm -rf dist' }));
  assert.deepEqual(first, { kind: 'refused', waitMs: 10000 });
  assert.deepEqual(second, { kind: 'approved', waitMs: 20000 });
  const early = askAnswer(rmRecord(at(9, 5), { transcriptPath: main, toolUseId: 'tu-1' }));
  assert.deepEqual(early, { kind: 'refused', waitMs: null });
});

test('a result copy without a timestamp is ignored when a timed one exists', () => {
  const home = newHome();
  const blob = { type: 'system', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] } };
  const main = writeJsonl(path.join(home, 't.jsonl'), [toolUse(at(9), 'tu-1', 'rm one'), blob, toolResult(at(9, 0, 30), 'tu-1')]);
  assert.deepEqual(askAnswer(rmRecord(at(9), { transcriptPath: main, toolUseId: 'tu-1' })), { kind: 'approved', waitMs: 30000 });
});
