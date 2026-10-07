import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { adviceKind, adviceLine, adviceQuestion, bandAdvice, increaseSuffix, modTail, parseState, usableJudgment, type ContextState, type Judgment } from '../src/display/line.js';

const REPO = path.resolve(import.meta.dirname, '..');
const T = 967000;
const WORKING: Judgment = { phase: 'working', clear: false };
const COMPACT: Judgment = { phase: 'unit_done', clear: false };
const CLEAR: Judgment = { phase: 'unit_done', clear: true };
const line = (size: number | null, judgment: Judgment | null, threshold: number | null = T, config: Config = DEFAULT_CONFIG) =>
  adviceLine({ size, threshold, judgment, config });

test('below 250k, or without a judgment, only the size shows', () => {
  assert.equal(line(null, CLEAR), '');
  assert.equal(line(52000, CLEAR), '52k');
  assert.equal(line(249000, WORKING), '249k');
  assert.equal(line(312000, null), '312k');
});

test('work in progress is green', () => {
  assert.equal(line(312000, WORKING), '🟢 312k');
  assert.equal(line(250000, WORKING), '🟢 250k');
});

test('a closed stage suggests /clear from 250k', () => {
  assert.equal(line(249000, CLEAR), '249k');
  assert.equal(line(250000, CLEAR), '🟡 250k 새롭게 시작하는 건 어떠세요? /clear');
  assert.equal(line(312000, CLEAR), '🟡 312k 새롭게 시작하는 건 어떠세요? /clear');
});

test('a finished unit suggests /compact from 250k', () => {
  assert.equal(line(249000, COMPACT), '249k');
  assert.equal(line(250000, COMPACT), '🟡 250k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(line(312000, COMPACT), '🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
});

test('adviceKind names the advice the line shows outside the red zone', () => {
  assert.equal(adviceKind(312000, CLEAR, DEFAULT_CONFIG), 'clear');
  assert.equal(adviceKind(312000, COMPACT, DEFAULT_CONFIG), 'compact');
  assert.equal(adviceKind(312000, WORKING, DEFAULT_CONFIG), null);
  assert.equal(adviceKind(249000, CLEAR, DEFAULT_CONFIG), null);
  assert.equal(adviceKind(null, CLEAR, DEFAULT_CONFIG), null);
  const later: Config = { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, compactMinTokens: 400000 } };
  assert.equal(adviceKind(312000, COMPACT, later), null);
});

test('within 20% of auto-compact the line is red with the percent left', () => {
  assert.equal(line(773000, WORKING), '🟢 773k');
  assert.equal(line(790000, null), '🔴 790k 18%');
  assert.equal(line(790000, WORKING), '🔴 790k 18% · 작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(line(790000, COMPACT), '🔴 790k 18% · 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(line(790000, CLEAR), '🔴 790k 18% · 새롭게 시작하는 건 어떠세요? /clear');
  assert.equal(line(980000, null), '🔴 980k 0%');
});

test('without a known threshold there is no red', () => {
  assert.equal(line(950000, WORKING, null), '🟢 950k');
});

test('thresholds and the language come from the config', () => {
  const en: Config = { ...DEFAULT_CONFIG, lang: 'en', context: { ...DEFAULT_CONFIG.context, minTokens: 10000, compactMinTokens: 20000, redRemainingPct: 50 } };
  assert.equal(line(15000, CLEAR, T, en), '🟡 15k Start fresh? /clear');
  assert.equal(line(25000, COMPACT, T, en), '🟡 25k Wrap up what you have and continue? /compact');
  assert.equal(line(15000, COMPACT, T, en), '🟢 15k');
  assert.equal(line(500000, WORKING, T, en), '🔴 500k 48% · When this work is done, wrap up and continue? /compact');
});

test('a judgment is used only when it is newer than the turn and the size has not dropped', () => {
  const state: ContextState = { sessionId: 's', at: 2000, size: 400000, judgment: CLEAR };
  assert.deepEqual(usableJudgment(state, 410000, 1000), CLEAR);
  assert.equal(usableJudgment(state, 410000, 3000), null);
  assert.equal(usableJudgment(state, 80000, 1000), null);
  assert.deepEqual(usableJudgment(state, null, 0), CLEAR);
  assert.equal(usableJudgment(null, 410000, 0), null);
  assert.equal(usableJudgment({ ...state, judgment: null }, 410000, 0), null);
});

test('parseState keeps a well-formed state and drops what it cannot trust', () => {
  assert.deepEqual(parseState({ sessionId: 's', at: 5, size: 312000, judgment: { phase: 'unit_done', clear: true }, extra: 1 }), { sessionId: 's', at: 5, size: 312000, judgment: CLEAR });
  assert.deepEqual(parseState({ sessionId: 's', at: 5, size: 'big', judgment: { phase: 'done', clear: true } }), { sessionId: 's', at: 5, size: null, judgment: null });
  assert.equal(parseState({ sessionId: 's' }), null);
  assert.equal(parseState(null), null);
});

test('the increase follows the size, rounded to whole k, and shows only when the conversation grew', () => {
  assert.equal(increaseSuffix(null), '');
  assert.equal(increaseSuffix(undefined), '');
  assert.equal(increaseSuffix(499), '');
  assert.equal(increaseSuffix(500), ' +1k');
  assert.equal(increaseSuffix(38000), ' +38k');
  assert.equal(increaseSuffix(-5000), '');
  const grown = (size: number, judgment: Judgment | null) => adviceLine({ size, threshold: T, judgment, config: DEFAULT_CONFIG, increase: 38000 });
  assert.equal(grown(52000, null), '52k +38k');
  assert.equal(grown(312000, WORKING), '🟢 312k +38k');
  assert.equal(grown(312000, COMPACT), '🟡 312k +38k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(grown(790000, CLEAR), '🔴 790k +38k 18% · 새롭게 시작하는 건 어떠세요? /clear');
});

test('bandAdvice names the button for advice that can be acted on now', () => {
  const band = (size: number | null, judgment: Judgment | null) => bandAdvice({ size, threshold: T, judgment, config: DEFAULT_CONFIG });
  assert.equal(band(null, CLEAR), null);
  assert.equal(band(249000, CLEAR), null);
  assert.equal(band(312000, null), null);
  assert.equal(band(312000, WORKING), null);
  assert.deepEqual(band(312000, COMPACT), { kind: 'compact', remainingPct: null });
  assert.deepEqual(band(312000, CLEAR), { kind: 'clear', remainingPct: null });
  assert.deepEqual(band(790000, CLEAR), { kind: 'clear', remainingPct: 18 });
  assert.deepEqual(band(790000, COMPACT), { kind: 'compact', remainingPct: 18 });
  assert.equal(band(790000, WORKING), null);
  assert.equal(band(790000, null), null);
  const later = { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, compactMinTokens: 400000 } };
  assert.equal(bandAdvice({ size: 312000, threshold: T, judgment: COMPACT, config: later }), null);
});

test('with a band the tail keeps the size and the increase; without one it is the full line', () => {
  const tail = (size: number, judgment: Judgment | null) => modTail({ size, threshold: T, judgment, config: DEFAULT_CONFIG, increase: 38000 });
  assert.equal(tail(312000, COMPACT), '312k +38k');
  assert.equal(tail(312000, CLEAR), '312k +38k');
  assert.equal(tail(790000, CLEAR), '790k +38k');
  assert.equal(tail(312000, WORKING), '🟢 312k +38k');
  assert.equal(tail(790000, WORKING), '🔴 790k +38k 18% · 작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(modTail({ size: null, threshold: T, judgment: CLEAR, config: DEFAULT_CONFIG }), '');
});

test('adviceQuestion is the advice without its command, in the configured language', () => {
  assert.equal(adviceQuestion('clear', 'ko'), '새롭게 시작하는 건 어떠세요?');
  assert.equal(adviceQuestion('compact', 'en'), 'Wrap up what you have and continue?');
});

test('the code the mod bundle uses imports nothing from Node', () => {
  for (const file of ['src/display/line.ts', 'src/config-shape.ts', 'src/display/shortcut.ts', 'src/mod/band.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, file), 'utf8'), /from ['"]node:|require\(/);
  }
});
