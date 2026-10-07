import type { Config, Lang } from '../config-shape.js';

export type Judgment = { phase: 'working' | 'unit_done'; clear: boolean };
export type AdviceKind = 'clear' | 'compact';
export type ContextState = { sessionId: string; at: number; size: number | null; judgment: Judgment | null };
export type LineInput = { size: number | null; threshold: number | null; judgment: Judgment | null; config: Config; increase?: number | null };
export type BandAdvice = { kind: AdviceKind; remainingPct: number | null };

export const STALE_SIZE_RATIO = 0.7;

type Advice = AdviceKind | 'compactLater';

const QUESTIONS: Record<Lang, Record<Advice, string>> = {
  ko: {
    clear: '새롭게 시작하는 건 어떠세요?',
    compact: '지금까지 정리하고 이어가는 건 어떠세요?',
    compactLater: '작업이 끝나면 정리하고 이어가는 건 어떠세요?',
  },
  en: {
    clear: 'Start fresh?',
    compact: 'Wrap up what you have and continue?',
    compactLater: 'When this work is done, wrap up and continue?',
  },
};

const COMMANDS: Record<Advice, string> = { clear: '/clear', compact: '/compact', compactLater: '/compact' };

const phrase = (lang: Lang, advice: Advice) => `${QUESTIONS[lang][advice]} ${COMMANDS[advice]}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function adviceQuestion(kind: AdviceKind, lang: Lang): string {
  return QUESTIONS[lang][kind];
}

export function formatSize(tokens: number): string {
  return `${Math.round(tokens / 1000)}k`;
}

export function remainingPct(size: number, threshold: number): number {
  return Math.max(0, Math.round(((threshold - size) / threshold) * 100));
}

export function adviceKind(size: number | null, judgment: Judgment | null, config: Config): AdviceKind | null {
  if (size === null || size < config.context.minTokens || !judgment || judgment.phase === 'working') return null;
  if (judgment.clear) return 'clear';
  return size >= config.context.compactMinTokens ? 'compact' : null;
}

export function increaseSuffix(increase: number | null | undefined): string {
  if (increase === null || increase === undefined) return '';
  const k = Math.round(increase / 1000);
  return k > 0 ? ` +${k}k` : '';
}

function redRemaining(size: number, threshold: number | null, config: Config): number | null {
  if (threshold === null || threshold <= 0 || size < threshold * (1 - config.context.redRemainingPct / 100)) return null;
  return remainingPct(size, threshold);
}

export function adviceLine({ size, threshold, judgment, config, increase }: LineInput): string {
  if (size === null) return '';
  const k = `${formatSize(size)}${increaseSuffix(increase)}`;
  const counted = size >= config.context.minTokens ? judgment : null;
  const red = redRemaining(size, threshold, config);
  if (red !== null) {
    const head = `🔴 ${k} ${red}%`;
    if (!counted) return head;
    if (counted.phase === 'working') return `${head} · ${phrase(config.lang, 'compactLater')}`;
    return `${head} · ${phrase(config.lang, counted.clear ? 'clear' : 'compact')}`;
  }
  if (!counted) return k;
  const kind = adviceKind(size, counted, config);
  return kind ? `🟡 ${k} ${phrase(config.lang, kind)}` : `🟢 ${k}`;
}

export function bandAdvice({ size, threshold, judgment, config }: LineInput): BandAdvice | null {
  if (size === null) return null;
  const counted = size >= config.context.minTokens ? judgment : null;
  if (!counted || counted.phase === 'working') return null;
  const red = redRemaining(size, threshold, config);
  if (red !== null) return { kind: counted.clear ? 'clear' : 'compact', remainingPct: red };
  const kind = adviceKind(size, counted, config);
  return kind ? { kind, remainingPct: null } : null;
}

export function modTail(input: LineInput): string {
  if (input.size === null) return '';
  return bandAdvice(input) ? `${formatSize(input.size)}${increaseSuffix(input.increase)}` : adviceLine(input);
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
