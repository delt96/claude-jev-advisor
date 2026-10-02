export type Lang = 'ko' | 'en';
export type Display = 'mod' | 'statusline' | 'message';
export type ContextConfig = {
  enabled: boolean;
  minTokens: number;
  compactMinTokens: number;
  redRemainingPct: number;
  unitDoneYes: number;
  goalDoneYes: number;
};
export type RmConfig = { enabled: boolean; jev: boolean; throwawayYes: number; maxDirFiles: number };
export type Config = { lang: Lang; keyFile: string | null; display: Display; context: ContextConfig; rm: RmConfig };

export const DEFAULT_CONFIG: Config = {
  lang: 'ko',
  keyFile: null,
  display: 'mod',
  context: { enabled: true, minTokens: 100000, compactMinTokens: 200000, redRemainingPct: 20, unitDoneYes: 0.7, goalDoneYes: 0.8 },
  rm: { enabled: true, jev: true, throwawayYes: 0.8, maxDirFiles: 50 },
};

const LANGS: readonly string[] = ['ko', 'en'];
const DISPLAYS: readonly string[] = ['mod', 'statusline', 'message'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeSection<T extends Record<string, unknown>>(defaults: T, raw: unknown): T {
  const out: Record<string, unknown> = { ...defaults };
  if (!isRecord(raw)) return out as T;
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof raw[key] === typeof value) out[key] = raw[key];
  }
  return out as T;
}

export function normalizeConfig(raw: unknown): Config {
  const r = isRecord(raw) ? raw : {};
  return {
    lang: typeof r.lang === 'string' && LANGS.includes(r.lang) ? (r.lang as Lang) : DEFAULT_CONFIG.lang,
    keyFile: typeof r.keyFile === 'string' && r.keyFile !== '' ? r.keyFile : null,
    display: typeof r.display === 'string' && DISPLAYS.includes(r.display) ? (r.display as Display) : DEFAULT_CONFIG.display,
    context: mergeSection(DEFAULT_CONFIG.context, r.context),
    rm: mergeSection(DEFAULT_CONFIG.rm, r.rm),
  };
}
