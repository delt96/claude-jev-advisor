import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../src/config.js';
import { register } from '../src/mod/register.js';

type AnyFn = (...args: any[]) => any;
type Fail = { usage?: boolean; now?: boolean; read?: 'throw' | 'object'; compact?: string };
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };

Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children: children.flat() }),
});

function buttonOf(tree: unknown): Node | undefined {
  if (typeof tree !== 'object' || tree === null) return undefined;
  const node = tree as Node;
  if (node.type === 'Button') return node;
  for (const child of node.children) {
    const found = buttonOf(child);
    if (found) return found;
  }
  return undefined;
}

const CONFIG_FILE = 'D:/data/config.json';
const STATE_FILE = 'D:/data/state/sess-1.json';
const state = (at: number, size: number, judgment: object | null) => ({ sessionId: 'sess-1', at, size, judgment });

function harness(opts: { dataDir?: string; files: Record<string, unknown>; tokens?: number; threshold?: number; fail?: Fail }) {
  const hooks = new Map<string, { matcher: unknown; hook: AnyFn }>();
  const on = (event: string, a: unknown, b?: unknown) => {
    const matcher = b === undefined ? null : a;
    const component = (matcher as { component?: string } | null)?.component;
    hooks.set(component ? `${event}:${component}` : event, { matcher, hook: (b ?? a) as AnyFn });
  };
  let timer = null as (() => void) | null;
  let now = 1000;
  let invalidations = 0;
  const live = { tokens: opts.tokens };
  const fail: Fail = opts.fail ?? {};
  const toasts: string[] = [];
  const calls = { compact: 0, run: [] as unknown[] };

  const $ = {
    session: {
      compact: async () => {
        calls.compact += 1;
        if (fail.compact) throw new Error(fail.compact);
        return {};
      },

      id: async () => 'sess-1',
      usage: async (args?: { breakdown?: string }) => {
        if (fail.usage) throw new Error('usage failed');
        return { context: { tokens: live.tokens, window: 1000000, ...(args?.breakdown ? { breakdown: { autoCompactThreshold: opts.threshold } } : {}) } };
      },
    },
    command: {
      run: async (args: unknown) => {
        calls.run.push(args);
        return { text: '' };
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
      toast: (text: string) => {
        toasts.push(text);
      },
      resolve: () => ({ Box: 'Box', Text: 'Text', Button: 'Button' }),
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
    toasts,
    calls,
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
    end: async () => hooks.get('session.end')?.hook($, { reason: 'clear', sessionId: 'sess-1' }, async () => 'engine'),
    band: async (props: Record<string, unknown> = {}) => {
      const e = { props: { hasSurvey: false, isWorking: false, maxRows: 20, ...props } };
      return hooks.get('ui.render:AbovePrompt')?.hook($, e, async () => 'engine');
    },
    press: async (tree: unknown) => {
      (buttonOf(tree)?.props.onPress as () => void)();
      await settle();
      await settle();
    },
    tail: async (): Promise<string | undefined> => {
      const e = { props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } };
      const out = await hooks.get('ui.render:PromptHint')?.hook($, e, async (next: typeof e) => next);
      return (out as { props: { tail?: string } }).props.tail;
    },
  };
}

test('the render hook targets the PromptHint row', () => {
  const h = harness({ files: {} });
  assert.deepEqual(h.hooks.get('ui.render:PromptHint')?.matcher, { component: 'PromptHint' });
});

test('the saved judgment for this session shows as a band, and the tail keeps the size', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: true }) }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '312k');
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/clear'));
});

test('a new request hides the old judgment until a newer one is saved', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'unit_done', clear: false }) };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '312k');
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/compact'));
  h.setNow(5000);
  assert.equal(await h.turnStart(), 'engine');
  assert.equal(await h.tail(), '312k');
  assert.equal(await h.band(), 'engine');
  files[STATE_FILE] = state(6000, 330000, { phase: 'working', clear: false });
  h.live.tokens = 330000;
  await h.tick();
  assert.equal(await h.tail(), '🟢 330k +18k');
});

test('the tail adds what the current request has added, and keeps it until the next request', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 300000, threshold: 967000 });
  await h.start();
  assert.equal(await h.tail(), '300k');
  await h.turnStart();
  assert.equal(await h.tail(), '300k');
  h.live.tokens = 338000;
  await h.tick();
  assert.equal(await h.tail(), '338k +38k');
});

test('an increase under half a k, or a shrink after /compact, is not shown', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG }, tokens: 300000, threshold: 967000 });
  await h.start();
  await h.turnStart();
  h.live.tokens = 300400;
  assert.equal(await h.tail(), '300k');
  h.live.tokens = 120000;
  assert.equal(await h.tail(), '120k');
});

test('the end of a session, as /clear ends it, drops the increase and the judgment before the poller runs again', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG };
  const h = harness({ files, tokens: 300000, threshold: 967000 });
  await h.start();
  await h.turnStart();
  files[STATE_FILE] = state(2000, 330000, { phase: 'working', clear: false });
  h.live.tokens = 330000;
  await h.tick();
  assert.equal(await h.tail(), '🟢 330k +30k');
  const before = h.invalidations();
  assert.equal(await h.end(), 'engine');
  assert.equal(h.invalidations(), before + 1);
  assert.equal(await h.tail(), '330k');
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
  assert.equal(await h.band(), 'engine');
});

const COMPACT_STATE = state(900, 312000, { phase: 'unit_done', clear: false });
const CLEAR_STATE = state(900, 312000, { phase: 'unit_done', clear: true });

test('the band hook targets the row above the prompt', () => {
  const h = harness({ files: {} });
  assert.deepEqual(h.hooks.get('ui.render:AbovePrompt')?.matcher, { component: 'AbovePrompt' });
});

test('no band while a turn runs, a survey is up, the work goes on, or another display or a switched-off helper is set', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.equal(await h.band({ isWorking: true }), 'engine');
  assert.equal(await h.band({ hasSurvey: true }), 'engine');
  const working = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: state(900, 312000, { phase: 'working', clear: false }) }, tokens: 312000, threshold: 967000 });
  await working.start();
  assert.equal(await working.band(), 'engine');
  const others: Config[] = [{ ...DEFAULT_CONFIG, display: 'statusline' }, { ...DEFAULT_CONFIG, context: { ...DEFAULT_CONFIG.context, enabled: false } }];
  for (const config of others) {
    const other = harness({ files: { [CONFIG_FILE]: config, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
    await other.start();
    assert.equal(await other.band(), 'engine');
  }
});

test('pressing compact compacts, and the band stays away for that judgment even when the poller reads it again', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  assert.equal(h.calls.compact, 1);
  assert.equal(await h.band(), 'engine');
  h.live.tokens = 260000;
  await h.tick();
  assert.equal(await h.band(), 'engine');
  assert.equal(await h.tail(), '260k');
});

test('pressing clear runs /clear', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  assert.deepEqual(h.calls.run, [{ command: 'clear' }]);
  assert.equal(await h.band(), 'engine');
});

test('a refused compact is shown as a toast and its button does not come back', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE }, tokens: 312000, threshold: 967000, fail: { compact: 'Not enough messages to compact.' } });
  await h.start();
  await h.press(await h.band());
  assert.deepEqual(h.toasts, ['/compact: Not enough messages to compact.']);
  assert.equal(await h.band(), 'engine');
});

test('a newer judgment brings the band back after one was acted on', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  await h.press(await h.band());
  files[STATE_FILE] = state(1500, 320000, { phase: 'unit_done', clear: true });
  h.live.tokens = 320000;
  await h.tick();
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/clear'));
});

test('after the session ends the band is gone before the poller runs again', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: CLEAR_STATE }, tokens: 312000, threshold: 967000 });
  await h.start();
  assert.notEqual(await h.band(), 'engine');
  await h.end();
  assert.equal(await h.band(), 'engine');
});

test('engine prefixes are removed from compact rejection toasts', async () => {
  const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE }, tokens: 312000, threshold: 967000, fail: { compact: 'jev-advisor: $.session.compact: Not enough messages to compact.' } });
  await h.start();
  await h.press(await h.band());
  assert.deepEqual(h.toasts, ['/compact: Not enough messages to compact.']);
});

test('the same drawn button handles each judgment only once', async () => {
  for (const saved of [COMPACT_STATE, CLEAR_STATE]) {
    const h = harness({ files: { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: saved }, tokens: 312000, threshold: 967000 });
    await h.start();
    const tree = await h.band();
    await h.press(tree);
    await h.press(tree);
    assert.equal(h.calls.compact, saved === COMPACT_STATE ? 1 : 0);
    assert.deepEqual(h.calls.run, saved === CLEAR_STATE ? [{ command: 'clear' }] : []);
  }
});

test('pressing an older tree leaves a newer polled judgment unhandled', async () => {
  const files: Record<string, unknown> = { [CONFIG_FILE]: DEFAULT_CONFIG, [STATE_FILE]: COMPACT_STATE };
  const h = harness({ files, tokens: 312000, threshold: 967000 });
  await h.start();
  const tree = await h.band();
  files[STATE_FILE] = state(1500, 312000, { phase: 'unit_done', clear: true });
  await h.tick();
  await h.press(tree);
  assert.equal(h.calls.compact, 1);
  assert.ok(String(buttonOf(await h.band())?.props.label).includes('/clear'));
});
