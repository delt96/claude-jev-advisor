import type { Config, Lang } from '../config-shape.js';

export type Judgment = { phase: 'working' | 'unit_done'; clear: boolean };
export type ContextState = { sessionId: string; at: number; size: number | null; judgment: Judgment | null };
export type LineInput = { size: number | null; threshold: number | null; judgment: Judgment | null; config: Config };

export const STALE_SIZE_RATIO = 0.7;

const PHRASES: Record<Lang, { clear: string; compact: string; compactLater: string }> = {
  ko: {
    clear: '새롭게 시작하는 건 어떠세요? /clear',
    compact: '지금까지 정리하고 이어가는 건 어떠세요? /compact',
    compactLater: '작업이 끝나면 정리하고 이어가는 건 어떠세요? /compact',
  },
  en: {
    clear: 'Start fresh? /clear',
    compact: 'Wrap up what you have and continue? /compact',
    compactLater: 'When this work is done, wrap up and continue? /compact',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatSize(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function remainingPct(size: number, threshold: number): number {
  return Math.max(0, Math.round(((threshold - size) / threshold) * 100));
}

export function adviceLine({ size, threshold, judgment, config }: LineInput): string {
  if (size === null) return '';
  const k = formatSize(size);
  const phrases = PHRASES[config.lang];
  const counted = size >= config.context.minTokens ? judgment : null;
  if (threshold !== null && threshold > 0 && size >= threshold * (1 - config.context.redRemainingPct / 100)) {
    const head = `🔴 ${k} ${remainingPct(size, threshold)}%`;
    if (!counted) return head;
    if (counted.phase === 'working') return `${head} · ${phrases.compactLater}`;
    return `${head} · ${counted.clear ? phrases.clear : phrases.compact}`;
  }
  if (!counted) return k;
  if (counted.phase === 'working') return `🟢 ${k}`;
  if (counted.clear) return `🟡 ${k} ${phrases.clear}`;
  if (size >= config.context.compactMinTokens) return `🟡 ${k} ${phrases.compact}`;
  return `🟢 ${k}`;
}

export function usableJudgment(state: ContextState | null, liveSize: number | null, turnStartedAt: number): Judgment | null {
  if (!state || !state.judgment || state.at < turnStartedAt) return null;
  if (liveSize !== null && state.size !== null && liveSize < state.size * STALE_SIZE_RATIO) return null;
  return state.judgment;
}

export function parseState(raw: unknown): ContextState | null {
  if (!isRecord(raw) || typeof raw.sessionId !== 'string' || typeof raw.at !== 'number') return null;
  const j = raw.judgment;
  const judgment: Judgment | null =
    isRecord(j) && (j.phase === 'working' || j.phase === 'unit_done') && typeof j.clear === 'boolean' ? { phase: j.phase, clear: j.clear } : null;
  return { sessionId: raw.sessionId, at: raw.at, size: typeof raw.size === 'number' ? raw.size : null, judgment };
}
