import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { register } from '../src/mod/register.js';

type AnyFn = (...args: any[]) => any;
const CONFIG_FILE = 'D:/data/config.json';
const STATE_FILE = 'D:/data/state/sess-1.json';
const state = (at: number, size: number, judgment: object | null) => ({ sessionId: 'sess-1', at, size, judgment });

function harness(opts: { dataDir?: string; files: Record<string, unknown>; tokens?: number; threshold?: number }) {
  const hooks = new Map<string, AnyFn>();
  const on = (event: string, a: unknown, b?: unknown) => {
    hooks.set(event, (b ?? a) as AnyFn);
  };
  let timer = null as (() => void) | null;
  let now = 1000;
  const live = { tokens: opts.tokens };
  const $ = {
    session: {
      id: async () => 'sess-1',
      usage: async (args?: { breakdown?: string }) => ({
        context: { tokens: live.tokens, window: 1000000, ...(args?.breakdown ? { breakdown: { autoCompactThreshold: opts.threshold } } : {}) },
      }),
    },
    fs: {
      read: async (file: string) => {
        if (file in opts.files) return JSON.stringify(opts.files[file]);
        throw new Error(`ENOENT ${file}`);
      },
    },
    clock: {
      now: async () => now,
      every: (_ms: number, fn: () => void) => {
        timer = fn;
        return {};
      },
    },
    ui: { invalidate: () => {} },
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
    setNow: (value: number) => {
      now = value;
    },
    start: async () => {
      await hooks.get('session.start')?.($, {}, async () => ({}));
      await tick();
    },
    turnStart: async () => {
      await hooks.get('turn.start')?.($, {}, async () => ({}));
    },
    tail: async (): Promise<string | undefined> => {
      const e = { props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } };
      const out = await hooks.get('ui.render')?.($, e, async (next: typeof e) => next);
      return (out as { props: { tail?: string } }).props.tail;
    },
  };
}

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
  await h.turnStart();
  assert.equal(await h.tail(), '312k');
  files[STATE_FILE] = state(6000, 330000, { phase: 'working', clear: false });
  h.live.tokens = 330000;
  await h.tick();
  assert.equal(await h.tail(), '🟢 330k');
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
