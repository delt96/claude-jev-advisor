import type { Engine, On } from 'claude-code';
import { normalizeConfig, type Config } from '../config-shape.js';
import { adviceLine, parseState, usableJudgment, type ContextState } from '../display/line.js';

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

export function register(on: On, options: Readonly<Record<string, unknown>>): void {
  const dataDir = typeof options.dataDir === 'string' ? options.dataDir.replace(/[\\/]+$/, '') : '';
  let config: Config | null = null;
  let state: ContextState | null = null;
  let threshold: number | null = null;
  let turnStartedAt = 0;
  let baseline: number | null = null;
  let seen = '';

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
        tail = adviceLine({ size, threshold, judgment: usableJudgment(state, size, turnStartedAt), config: current, increase });
      }
    } catch {
      tail = '';
    }
    return tail ? next({ ...e, props: { ...e.props, tail } }) : next(e);
  });
}
