import type { Engine, On } from 'claude-code';
import { normalizeConfig, type Config } from '../config-shape.js';
import { adviceLine, parseState, usableJudgment, type ContextState } from '../display/line.js';

const REFRESH_MS = 2000;

async function readJson($: Engine, file: string): Promise<unknown> {
  try {
    return JSON.parse(String(await $.fs.read(file)).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function loadConfig($: Engine, dataDir: string): Promise<Config> {
  return normalizeConfig(await readJson($, `${dataDir}/config.json`));
}

async function loadState($: Engine, dataDir: string): Promise<ContextState | null> {
  const sessionId = await $.session.id();
  const state = parseState(await readJson($, `${dataDir}/state/${sessionId}.json`));
  return state && state.sessionId === sessionId ? state : null;
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
    return (await $.session.usage()).context.tokens ?? null;
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
  let seen = '';

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    if (!dataDir) return result;
    config = await loadConfig($, dataDir);
    threshold = await autoCompactThreshold($);
    $.clock.every(REFRESH_MS, () => {
      Promise.all([loadConfig($, dataDir), loadState($, dataDir)])
        .then(([nextConfig, nextState]) => {
          const key = JSON.stringify([nextConfig, nextState]);
          if (key === seen) return;
          seen = key;
          config = nextConfig;
          state = nextState;
          $.ui.invalidate('ui.render');
        })
        .catch(() => {});
    });
    return result;
  });

  on('turn.start', async ($, e, next) => {
    turnStartedAt = await $.clock.now();
    $.ui.invalidate('ui.render');
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    threshold = await autoCompactThreshold($);
    return result;
  });

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const current = config;
    if (!current || !current.context.enabled || current.display !== 'mod') return next(e);
    const size = await liveSize($);
    const tail = adviceLine({ size, threshold, judgment: usableJudgment(state, size, turnStartedAt), config: current });
    return tail ? next({ ...e, props: { ...e.props, tail } }) : next(e);
  });
}
