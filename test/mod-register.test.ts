import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { register } from '../src/mod/register.js';

type AnyFn = (...args: any[]) => any;
type Fail = { usage?: boolean; now?: boolean; read?: 'throw' | 'object' };
const CONFIG_FILE = 'D:/data/config.json';
const STATE_FILE = 'D:/data/state/sess-1.json';
const state = (at: number, size: number, judgment: object | null) => ({ sessionId: 'sess-1', at, size, judgment });

function harness(opts: { dataDir?: string; files: Record<string, unknown>; tokens?: number; threshold?: number; fail?: Fail }) {
  const hooks = new Map<string, { matcher: unknown; hook: AnyFn }>();
  const on = (event: string, a: unknown, b?: unknown) => {
    hooks.set(event, b === undefined ? { matcher: null, hook: a as AnyFn } : { matcher: a, hook: b as AnyFn });
  };
  let timer = null as (() => void) | null;
  let now = 1000;
  let invalidations = 0;
  const live = { tokens: opts.tokens };
  const fail: Fail = opts.fail ?? {};
  const $ = {
    session: {
      id: async () => 'sess-1',
      usage: async (args?: { breakdown?: string }) => {
        if (fail.usage) throw new Error('usage failed');
        return { context: { tokens: live.tokens, window: 1000000, ...(args?.breakdown ? { breakdown: { autoCompactThreshold: opts.threshold } } : {}) } };
      },
    },
    fs: {
      read: async (file: string) => {
        if (fail.read === 'throw') throw new Error('read failed');
        if (fail.read === 'object') return { text: 'not a string' };
        if (file in opts.files) return JSON.stringify(opts.files[file]);
        throw new Error(`ENOENT ${file}`);
      },
    },
    clock: {
      now: async () => {
        if (fail.now) throw new Error('clock failed');
        return now;
      },
      every: (_ms: number, fn: () => void) => {
        timer = fn;
        return {};
      },
    },
    ui: {
      invalidate: () => {
        invalidations += 1;
      },
    },
  };
  register(on as never, { dataDir: opts.dataDir ?? 'D:/data' });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async () => {
    timer?.();
    await settle();
    await settle();
  };
  return {
    live,
    tick,
    hooks,
    invalidations: () => invalidations,
    setNow: (value: number) => {
      now = value;
    },
    start: async (event: object = {}) => {
      await hooks.get('session.start')?.hook($, event, async () => ({}));
      await tick();
    },
    turnStart: async () => hooks.get('turn.start')?.hook($, {}, async () => 'engine'),
    tail: async (): Promise<string | undefined> => {
      const e = { props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } };
      const out = await hooks.get('ui.render')?.hook($, e, async (next: typeof e) => next);
      return (out as { props: { tail?: string } }).props.tail;
    },
  };
}

test('the render hook targets the PromptHint row', () => {
  const h = harness({ files: {} });
  assert.deepEqual(h.hooks.get('ui.render')?.matcher, { component: 'PromptHint' });
});

test('the tail shows the saved judgment for this session', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: true }) }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '🟡 312k 새롭게 시작하는 건 어떠세요? /clear');
});

test('a new request hides the old judgment until a newer one is saved', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: false }) };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '🟡 312k 지금까지 정리하고 이어가는 건 어떠세요? /compact');
  h.setNow(5000);
  assert.equal(await h.turnStart(), 'engine');
  assert.equal(await h.tail(), '312k');
  files[STATE_FILE] = state(6000, 330000, { phase: 'working', clear: false });
  h.live.tokens = 330000;
  await h.tick();
  assert.equal(await h.tail(), '🟢 330k');
});

test('a redraw is asked for only when the config or the state changed', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(h.invalidations(), 1);
  await h.tick();
  assert.equal(h.invalidations(), 1);
  files[STATE_FILE] = state(900, 312000, { phase: 'working', clear: false });
  await h.tick();
  assert.equal(h.invalidations(), 2);
});

test('near auto-compact the tail is red even without a judgment', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 790000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '🔴 790k 18%');
});

test('after /compact a judgment made at a larger size is not shown', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 400000, { phase: 'unit_done', clear: true }) }, tokens: 80000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '80k');
});

test('another display, a switched-off helper or no data folder leaves the row alone', async () => {
  const others: Config[] = [{ ...DEFAULT_CONFIG, display: 'statusline' }, { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, enabled: false } }];
  for (const config of others) {
    const h = harness({ files: { [CONFIG_FILE]: config }, tokens: 312000, threshold: 967000 });
    await h.start();
    assert.equal(await h.tail(), undefined);
  }
  const unset = harness({ dataDir: '', files: {}, tokens: 312000 });
  await unset.start();
  assert.equal(await unset.tail(), undefined);
});

test('failing APIs leave the engine row and events as they are', async () => {
  const files = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: true }) };
  for (const fail of [{ usage: true }, { read: 'throw' as const }, { read: 'object' as const }]) {
    const h = harness({ files, tokens: 312000, threshold: 967000, fail });
    await h.start();
    assert.equal(await h.tail(), undefined, JSON.stringify(fail));
  }
  const clock = harness({ files, tokens: 312000, threshold: 967000, fail: { now: true } });
  await clock.start();
  assert.equal(await clock.turnStart(), 'engine');
});

test('a config that cannot be read keeps the last good one', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: { ...DEFAULT_CONFIG, display: 'statusline' } };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), undefined);
  delete files[CONFIG_FILE];
  await h.tick();
  assert.equal(await h.tail(), undefined);
});

test('the row is redrawn when the shown size changes, so red appears during a turn', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 700000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '700k');
  const before = h.invalidations();
  h.live.tokens = 790000;
  await h.tick();
  assert.equal(h.invalidations(), before + 1);
  assert.equal(await h.tail(), '🔴 790k 18%');
});

test('no size is shown before the first reply', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 0, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), undefined);
});

test('a headless session starts no poller and draws nothing', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 312000, threshold: 967000 });
  await h.start({ isInteractive: false });
  assert.equal(h.invalidations(), 0);
  assert.equal(await h.tail(), undefined);
});
