import type { Engine, On } from 'claude-code';
import { normalizeConfig, type Config } from '../config-shape.js';
import { bandAdvice, modTail, parseState, usableJudgment, type AdviceKind, type ContextState, type Judgment } from '../display/line.js';
import { drawBand } from './band.js';

const REFRESH_MS = 2000;

async function readJson($: Engine, file: string): Promise<unknown> {
  try {
    const text = await $.fs.read(file);
    return typeof text === 'string' ? JSON.parse(text.replace(/^\uFEFF/, '')) : undefined;
  } catch {
    return undefined;
  }
}

async function loadConfig($: Engine, dataDir: string): Promise<Config | null> {
  const raw = await readJson($, `${dataDir}/config.json`);
  return raw === undefined ? null : normalizeConfig(raw);
}

async function loadState($: Engine, dataDir: string): Promise<ContextState | null> {
  try {
    const sessionId = await $.session.id();
    const state = parseState(await readJson($, `${dataDir}/state/${sessionId}.json`));
    return state && state.sessionId === sessionId ? state : null;
  } catch {
    return null;
  }
}

async function autoCompactThreshold($: Engine): Promise<number | null> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' });
    return usage.context.breakdown?.autoCompactThreshold ?? null;
  } catch {
    return null;
  }
}

async function liveSize($: Engine): Promise<number | null> {
  try {
    const tokens = (await $.session.usage()).context.tokens;
    return typeof tokens === 'number' && tokens > 0 ? tokens : null;
  } catch {
    return null;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function press($: Engine, kind: AdviceKind): Promise<void> {
  try {
    $.ui.invalidate('ui.render');
    if (kind === 'compact') {
      const result = await $.session.compact();
      if (result?.skip) $.ui.toast('/compact: skipped by a hook');
    } else {
      await $.command.run({ command: 'clear' });
    }
  } catch (err) {
    try {
      $.ui.toast(`/${kind}: ${reason(err)}`);
    } catch {}
  }
}

export function register(on: On, options: Readonly<Record<string, unknown>>): void {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir.replace(/[\\/]+$/, '') : '';
  let config: Config | null = null;
  let state: ContextState | null = null;
  let threshold: number | null = null;
  let turnStartedAt = 0;
  let baseline: number | null = null;
  let seen = '';
  let handledAt = -Infinity;

  const judgmentFor = (size: number | null): Judgment | null => (state && state.at <= handledAt ? null : usableJudgment(state, size, turnStartedAt));

  // A failing mod must never swallow Claude Code's events or blank its row: every hook calls next(e) outside its try.
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    if (!dataDir || e.isInteractive === false) return result;
    try {
      config = await loadConfig($, dataDir);
      threshold = await autoCompactThreshold($);
      $.clock.every(REFRESH_MS, () => {
        Promise.all([loadConfig($, dataDir), loadState($, dataDir), liveSize($)])
          .then(([nextConfig, nextState, size]) => {
            const key = JSON.stringify([nextConfig, nextState, size === null ? null : Math.round(size / 1000)]);
            if (key === seen) return;
            seen = key;
            if (nextConfig) config = nextConfig;
            state = nextState;
            $.ui.invalidate('ui.render');
          })
          .catch(() => {});
      });
    } catch {}
    return result;
  });

  on('turn.start', async ($, e, next) => {
    baseline = null;
    try {
      turnStartedAt = await $.clock.now();
      baseline = await liveSize($);
      $.ui.invalidate('ui.render');
    } catch {}
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    threshold = await autoCompactThreshold($);
    return result;
  });

  // After /clear the engine raises no session.start, so the old session's values are dropped here.
  on('session.end', async ($, e, next) => {
    baseline = null;
    state = null;
    seen = '';
    try {
      $.ui.invalidate('ui.render');
    } catch {}
    return next(e);
  });

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    let tail = '';
    try {
      const current = config;
      if (current && current.context.enabled && current.display === 'mod') {
        const size = await liveSize($);
        const increase = baseline !== null && size !== null ? size - baseline : null;
        tail = modTail({ size, threshold, judgment: judgmentFor(size), config: current, increase });
      }
    } catch {
      tail = '';
    }
    return tail ? next({ ...e, props: { ...e.props, tail } }) : next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    let band: unknown = null;
    try {
      const current = config;
      const props = e.props ?? {};
      if (current && current.context.enabled && current.display === 'mod' && props.isWorking !== true && props.hasSurvey !== true) {
        const size = await liveSize($);
        const advice = bandAdvice({ size, threshold, judgment: judgmentFor(size), config: current });
        if (advice) band = drawBand($.ui.resolve(e), { advice, config: current, onPress: () => {
          handledAt = state?.at ?? handledAt;
          void press($, advice.kind);
        } });
      }
    } catch {
      band = null;
    }
    return band ?? next(e);
  });
}
