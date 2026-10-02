export type Lang = 'ko' | 'en';
export type Display = 'mod' | 'statusline' | 'message';
export type ContextConfig = {
  enabled: boolean;
  minTokens: number;
  compactMinTokens: number;
  redRemainingPct: number;
  unitDoneYes: number;
  phaseDoneYes: number;
};
export type RmConfig = { enabled: boolean; jev: boolean; throwawayYes: number; maxDirFiles: number };
export type Config = { lang: Lang; keyFile: string | null; display: Display; context: ContextConfig; rm: RmConfig };

export const CONFIG_VERSION = 2;

export const DEFAULT_CONFIG: Config = {
  lang: 'ko',
  keyFile: null,
  display: 'mod',
  context: { enabled: true, minTokens: 250000, compactMinTokens: 250000, redRemainingPct: 20, unitDoneYes: 0.6, phaseDoneYes: 0.6 },
  rm: { enabled: true, jev: true, throwawayYes: 0.8, maxDirFiles: 50 },
};

// Version 0.1.x saved every value, defaults included, and no version. Its default thresholds are read as unset so
// the current defaults apply; someone who had picked exactly one of these values has to set it again.
const LEGACY_CONTEXT_DEFAULTS: Record<string, unknown> = { minTokens: 100000, compactMinTokens: 200000, unitDoneYes: 0.7 };

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

function withoutLegacyDefaults(context: unknown): unknown {
  if (!isRecord(context)) return context;
  return Object.fromEntries(Object.entries(context).filter(([key, value]) => LEGACY_CONTEXT_DEFAULTS[key] !== value));
}

export function normalizeConfig(raw: unknown): Config {
  const r = isRecord(raw) ? raw : {};
  return {
    lang: typeof r.lang === 'string' && LANGS.includes(r.lang) ? (r.lang as Lang) : DEFAULT_CONFIG.lang,
    keyFile: typeof r.keyFile === 'string' && r.keyFile !== '' ? r.keyFile : null,
    display: typeof r.display === 'string' && DISPLAYS.includes(r.display) ? (r.display as Display) : DEFAULT_CONFIG.display,
    context: mergeSection(DEFAULT_CONFIG.context, r.version === CONFIG_VERSION ? r.context : withoutLegacyDefaults(r.context)),
    rm: mergeSection(DEFAULT_CONFIG.rm, r.rm),
  };
}

function changedValues(values: Record<string, unknown>, defaults: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== defaults[key]));
}

export function configToSave(config: Config): Record<string, unknown> {
  const { context, rm, ...top } = config;
  const { context: defaultContext, rm: defaultRm, ...defaultTop } = DEFAULT_CONFIG;
  const out: Record<string, unknown> = { version: CONFIG_VERSION, ...changedValues(top, defaultTop) };
  const changedContext = changedValues(context, defaultContext);
  const changedRm = changedValues(rm, defaultRm);
  if (Object.keys(changedContext).length) out.context = changedContext;
  if (Object.keys(changedRm).length) out.rm = changedRm;
  return out;
}
