import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { QUESTIONS, cutReply, hasBackgroundTasks, jevRequest, judgmentFrom } from '../src/context/judge.js';

test('a long reply keeps its first and last 1500 characters', () => {
  assert.equal(cutReply('short'), 'short');
  const reply = `${'a'.repeat(2000)}${'b'.repeat(2000)}`;
  assert.equal(cutReply(reply), `${'a'.repeat(1500)}\n…\n${'b'.repeat(1500)}`);
  assert.equal(cutReply('x'.repeat(3000)), 'x'.repeat(3000));
});

test('the request carries the requests, the cut reply and both questions in English', () => {
  const request = jevRequest(['r1'.repeat(500), 'r2', 'r3'], 'z'.repeat(5000));
  assert.deepEqual(Object.keys(request.state), ['recent_requests', 'last_assistant_reply']);
  assert.deepEqual(request.state.recent_requests, ['r1'.repeat(500), 'r2', 'r3']);
  assert.equal((request.state.last_assistant_reply as string).length, 3003);
  assert.deepEqual(Object.keys(request.questions), ['unit_done', 'phase_done']);
  for (const q of Object.values(request.questions)) {
    assert.equal(q.type, 'noul');
    assert.match(q.instructions, /`last_assistant_reply`/);
    assert.doesNotMatch(JSON.stringify(q), /[가-힣]/);
  }
  assert.match(request.questions.unit_done.instructions, /`recent_requests`/);
  assert.deepEqual(request.questions, QUESTIONS);
  assert.ok(JSON.stringify(request).length < 10000);
});

test('unit_done under 0.6 means working; from 0.6 the unit is done', () => {
  assert.deepEqual(judgmentFrom({ unit_done: 0.59, phase_done: 0.1 }, DEFAULT_CONFIG), { phase: 'working', clear: false });
  assert.deepEqual(judgmentFrom({ unit_done: 0.6, phase_done: 0.1 }, DEFAULT_CONFIG), { phase: 'unit_done', clear: false });
});

test('a closed stage (phase_done 0.6 or more) means clear, whatever unit_done says', () => {
  assert.deepEqual(judgmentFrom({ unit_done: 0.9, phase_done: 0.59 }, DEFAULT_CONFIG), { phase: 'unit_done', clear: false });
  assert.deepEqual(judgmentFrom({ unit_done: 0.9, phase_done: 0.6 }, DEFAULT_CONFIG), { phase: 'unit_done', clear: true });
  assert.deepEqual(judgmentFrom({ unit_done: 0.3, phase_done: 0.8 }, DEFAULT_CONFIG), { phase: 'unit_done', clear: true });
  assert.deepEqual(judgmentFrom({ unit_done: 0.9 }, DEFAULT_CONFIG), { phase: 'unit_done', clear: false });
  assert.equal(judgmentFrom({ phase_done: 0.9 }, DEFAULT_CONFIG), null);
});

test('the thresholds come from the config', () => {
  const config: Config = { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, unitDoneYes: 0.5, phaseDoneYes: 0.95 } };
  assert.deepEqual(judgmentFrom({ unit_done: 0.55, phase_done: 0.9 }, config), { phase: 'unit_done', clear: false });
  assert.deepEqual(judgmentFrom({ unit_done: 0.45, phase_done: 0.9 }, config), { phase: 'working', clear: false });
});

test('background tasks count only when there are some', () => {
  assert.equal(hasBackgroundTasks([]), false);
  assert.equal(hasBackgroundTasks(undefined), false);
  assert.equal(hasBackgroundTasks({}), false);
  assert.equal(hasBackgroundTasks([{ id: 'b1' }]), true);
  assert.equal(hasBackgroundTasks({ b1: { status: 'running' } }), true);
});
