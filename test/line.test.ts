import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { adviceLine, parseState, usableJudgment, type ContextState, type Judgment } from '../src/display/line.js';

const REPO = path.resolve(import.meta.dirname, '..');
const T = 967000;
const WORKING: Judgment = { phase: 'working', clear: false };
const COMPACT: Judgment = { phase: 'unit_done', clear: false };
const CLEAR: Judgment = { phase: 'unit_done', clear: true };
const line = (size: number | null, judgment: Judgment | null, threshold: number | null = T, config: Config = DEFAULT_CONFIG) =>
  adviceLine({ size, threshold, judgment, config });

test('below 100k, or without a judgment, only the size shows', () => {
  assert.equal(line(null, CLEAR), '');
  assert.equal(line(52000, CLEAR), '52k');
  assert.equal(line(99000, WORKING), '99k');
  assert.equal(line(312000, null), '312k');
});

test('work in progress is green', () => {
  assert.equal(line(312000, WORKING), '🟢 312k');
  assert.equal(line(100000, WORKING), '🟢 100k');
});

test('a finished goal suggests /clear from 100k', () => {
  assert.equal(line(150000, CLEAR), '🟡 150k 새롭게 시작하는 건 어떠세요? /clear');
  assert.equal(line(312000, CLEAR), '🟡 312k 새롭게 시작하는 건 어떠세요? /clear');
});

test('a finished unit suggests /compact only from 200k', () => {
  assert.equal(line(199000, COMPACT), '🟢 199k');
  assert.equal(line(200000, COMPACT), '🟡 200k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  assert.equal(line(312000, COMPACT), '🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
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

test('the display code and the config shape import nothing from Node, so the mod bundle can use them', () => {
  for (const file of ['src/display/line.ts', 'src/config-shape.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO, file), 'utf8'), /from ['"]node:|require\(/);
  }
});
